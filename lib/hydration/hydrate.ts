import type { OutputConfig } from "../config.js"
import { getHydrationPermissionEventId } from "../inbox/ids.js"
import type { PluginState, InboxEvent, TaskRunRecord, TerminalSessionSummary, WorkerSummary } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { truncateSummary } from "../inbox/summary.js"
import {
  setConnectionStatus,
  setCapabilities,
  upsertWorker,
  upsertTerminal,
  insertInboxEvent,
  mapAgentToWorkerSummary,
  getOrCreateSession,
  getTaskRun,
  findSessionsForResource,
  recordBackgroundWorker,
  recordCreatedWorker,
  recordTaskRun,
  buildBlockingMetadata,
} from "../state/state.js"
import { getTaskLabelInfo } from "../task-labels.js"
import { getWorkerSessionIdFromLabels } from "../worker-launch/queue.js"

// ─── Startup Hydration ───────────────────────────────────────────────────────
// Fetches current agents (workers) and terminals from the daemon,
// seeds inbox with blocking items from current attention state.
// Server info (version, features) is already available from the hello handshake.
// Does NOT replay full history or synthesize noisy notifications.

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface HydrationResult {
  workers: number
  terminals: number
  chatRooms: number
  inboxSeeded: number
}

export async function hydrate(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  output: OutputConfig,
  onWorkerObserved?: (worker: WorkerSummary) => void,
  onTaskWorkerRestored?: (worker: WorkerSummary) => void,
): Promise<HydrationResult> {
  hydrateCapabilities(state, client, logger)
  const { workers, inboxSeeded } = await hydrateWorkers(
    state,
    client,
    logger,
    output,
    onWorkerObserved,
    onTaskWorkerRestored,
  )
  const chatRooms = state.chatRooms.size
  const terminals = await hydrateTerminals(state, client, logger)

  setConnectionStatus(state, "connected")
  logger.info("Hydration complete", { workers, terminals, chatRooms, inboxSeeded })

  return { workers, terminals, chatRooms, inboxSeeded }
}

function hydrateCapabilities(state: PluginState, client: PaseoTransport, logger: Logger): void {
  const serverInfo = client.getServerInfo()
  if (!serverInfo) {
    logger.warn("No server info available from handshake")
    return
  }
  const features = Object.keys(serverInfo.features).filter((key) => serverInfo.features[key])
  setCapabilities(state, {
    ...(serverInfo.version !== undefined ? { version: serverInfo.version } : {}),
    features,
    fetchedAt: Date.now(),
  })
  logger.info("Server info from handshake", { serverId: serverInfo.serverId, version: serverInfo.version, features })
}

async function hydrateWorkers(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  output: OutputConfig,
  onWorkerObserved?: (worker: WorkerSummary) => void,
  onTaskWorkerRestored?: (worker: WorkerSummary) => void,
): Promise<Pick<HydrationResult, "workers" | "inboxSeeded">> {
  let workers = 0
  let inboxSeeded = 0
  try {
    const agents = await client.fetchAgents({ subscribe: { subscriptionId: "opencode-paseo" } })
    for (const agent of agents) {
      const worker = mapAgentToWorkerSummary(agent)
      upsertWorker(state, worker)
      restoreTaskWorkerBinding(state, worker, agent, onTaskWorkerRestored)
      restoreDurableWorkerBinding(state, worker, agent)
      onWorkerObserved?.(worker)
      workers++
      inboxSeeded += seedActionableWorkerInboxEvents(state, worker, agent, output)
    }
    logger.info("Hydrated agents", { count: workers })
  } catch (err: unknown) {
    logger.warn("Agent hydration failed", getErrorMessage(err))
  }
  return { workers, inboxSeeded }
}

function restoreDurableWorkerBinding(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
): void {
  if (getTaskLabelInfo(agent.labels)) return
  const sessionId = getWorkerSessionIdFromLabels(agent.labels)
  if (!sessionId) return
  getOrCreateSession(state, sessionId, worker.cwd)
  recordCreatedWorker(state, sessionId, worker)
  recordBackgroundWorker(state, sessionId, worker.id)
}

function restoreTaskWorkerBinding(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  onTaskWorkerRestored?: (worker: WorkerSummary) => void,
): void {
  const taskInfo = getTaskLabelInfo(agent.labels)
  if (!taskInfo) return
  getOrCreateSession(state, taskInfo.taskSessionId, worker.cwd)
  getOrCreateSession(state, taskInfo.parentSessionId, worker.cwd)
  recordCreatedWorker(state, taskInfo.taskSessionId, worker)
  recordCreatedWorker(state, taskInfo.parentSessionId, worker)
  const existing = getTaskRun(state, taskInfo.taskSessionId)
  const taskRun = hydratedTaskRunRecord(worker, agent.labels, taskInfo, existing)
  recordTaskRun(state, taskRun)
  if (taskRun.background) {
    recordBackgroundWorker(state, taskRun.taskSessionId, worker.id)
    recordBackgroundWorker(state, taskRun.parentSessionId, worker.id)
  }
  onTaskWorkerRestored?.(worker)
}

function hydratedTaskRunRecord(
  worker: WorkerSummary,
  labels: Record<string, string>,
  taskInfo: NonNullable<ReturnType<typeof getTaskLabelInfo>>,
  existing: TaskRunRecord | undefined,
): TaskRunRecord {
  const completionInjected = taskCompletionInjected(existing, taskInfo)
  return {
    taskSessionId: taskInfo.taskSessionId,
    parentSessionId: taskInfo.parentSessionId,
    workerId: worker.id,
    description: taskInfo.description ?? worker.title,
    subagentType: taskInfo.subagentType ?? worker.currentModeId ?? worker.provider,
    background: taskBackground(existing, taskInfo, completionInjected),
    completionInjected,
    labels,
    createdAt: existing?.createdAt ?? Date.now(),
  }
}

function taskCompletionInjected(
  existing: TaskRunRecord | undefined,
  taskInfo: NonNullable<ReturnType<typeof getTaskLabelInfo>>,
): boolean | undefined {
  return existing?.completionInjected ?? taskInfo.completionInjected
}

function taskBackground(
  existing: TaskRunRecord | undefined,
  taskInfo: NonNullable<ReturnType<typeof getTaskLabelInfo>>,
  completionInjected: boolean | undefined,
): boolean {
  return existing?.background ?? (taskInfo.deferred === true && completionInjected !== true)
}

function seedActionableWorkerInboxEvents(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  output: OutputConfig,
): number {
  if (findSessionsForResource(state, worker.id).length === 0) return 0
  let seeded = 0
  const hasActionableStatus = worker.status === "idle" || worker.status === "error" || worker.status === "closed"
  if (hasActionableStatus) {
    seeded += seedWorkerStatusInboxEvent(state, worker, agent, output)
  }
  if (worker.pendingPermissionIds.length > 0) {
    seeded += seedPermissionInboxEvents(state, worker, agent, output)
  } else if (!hasActionableStatus && worker.requiresAttention) {
    seeded += seedAgentAttentionInboxEvent(state, worker, agent, output)
  }
  return seeded
}

function seedPermissionInboxEvents(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  output: OutputConfig,
): number {
  let seeded = 0
  for (const permissionId of worker.pendingPermissionIds) {
    const permission = worker.pendingPermissions.find((entry) => entry.id === permissionId)
    const summary = permissionSummary(permission, worker, agent, output)
    const event: InboxEvent = {
      id: getHydrationPermissionEventId(permissionId),
      kind: "permission.requested",
      resourceId: agent.id,
      blocking: true,
      summary,
      read: false,
      timestamp: Date.now(),
      metadata: buildBlockingMetadata("permission.requested", agent.id, { permissionId }),
    }
    if (insertInboxEvent(state, event, output.maxInboxItems)) seeded++
  }
  return seeded
}

function permissionSummary(
  permission: Record<string, unknown> | undefined,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  output: OutputConfig,
): string {
  const rawSummary = permission?.summary ?? permission?.message ?? permission?.title ?? worker.attentionReason
  return truncateSummary(
    typeof rawSummary === "string" ? rawSummary : `Worker "${agent.title ?? agent.id}" requires permission`,
    output.maxSummaryLength,
  )
}

function seedWorkerStatusInboxEvent(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  output: OutputConfig,
): number {
  const event: InboxEvent = {
    id: `hydration-agent-status-${agent.id}-${worker.status}`,
    kind: "agent.status",
    resourceId: agent.id,
    blocking: false,
    summary: truncateSummary(`Worker "${agent.title ?? agent.id}" is ${worker.status}`, output.maxSummaryLength),
    read: false,
    timestamp: Date.now(),
    metadata: { workerId: agent.id, status: worker.status, previousStatus: null },
  }
  return insertInboxEvent(state, event, output.maxInboxItems) ? 1 : 0
}

function seedAgentAttentionInboxEvent(
  state: PluginState,
  worker: WorkerSummary,
  agent: Parameters<typeof mapAgentToWorkerSummary>[0],
  output: OutputConfig,
): number {
  const event: InboxEvent = {
    id: `hydration-agent-attention-${agent.id}`,
    kind: "agent.attention",
    resourceId: agent.id,
    blocking: false,
    summary: truncateSummary(
      agent.attentionReason ?? `Worker "${agent.title ?? agent.id}" requires attention`,
      output.maxSummaryLength,
    ),
    read: false,
    timestamp: Date.now(),
    metadata: { workerId: agent.id, status: worker.status, attentionReason: worker.attentionReason },
  }
  return insertInboxEvent(state, event, output.maxInboxItems) ? 1 : 0
}

async function hydrateTerminals(state: PluginState, client: PaseoTransport, logger: Logger): Promise<number> {
  let terminals = 0
  try {
    const terminalList = await client.listTerminals()
    for (const terminal of terminalList) {
      upsertTerminal(state, mapHydratedTerminal(terminal))
      terminals++
    }
    logger.info("Hydrated terminals", { count: terminals })
  } catch (err: unknown) {
    logger.warn("Terminal hydration failed", getErrorMessage(err))
  }
  return terminals
}

function mapHydratedTerminal(terminal: { id: string; title?: string; name?: string }): TerminalSessionSummary {
  return {
    id: terminal.id,
    title: terminal.title ?? terminal.name ?? terminal.id,
    cwd: "",
    status: "unknown",
    lineCount: 0,
    lastReadCursor: 0,
  }
}
