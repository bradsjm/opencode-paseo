import type { PluginConfig } from "../config.js"
import { getHydrationPermissionEventId } from "../inbox/ids.js"
import { truncateSummary } from "../inbox/summary.js"
import type { Logger } from "../logger.js"
import { formatNudgeMessage, sendNudge } from "../notifier.js"
import {
  buildBlockingMetadata,
  findBackgroundSessionsForResource,
  findSessionsForResource,
  getOrCreateSession,
  getTaskRun,
  getUnreadEventCountForResource,
  insertInboxEvent,
  markEventRead,
  mapAgentToWorkerSummary,
  recordBackgroundWorker,
  recordCreatedWorker,
  recordTaskRun,
  removeWorkerFromState,
  setConnectionStatus,
  upsertWorker,
} from "../state/state.js"
import type { InboxEvent, PluginState, TaskRunRecord, WorkerSummary } from "../state/types.js"
import type {
  AgentSummary,
  DaemonEvent,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
} from "../transport/types.js"
import type { OpencodeClient } from "../profile.js"
import { getWorkerLaunchIdFromLabels } from "../worker-launch/queue.js"
import { getTaskLabelInfo } from "../task-labels.js"

type WorkerObservedCallback = (worker: WorkerSummary, observedLaunchId?: string) => void
type TaskWorkerObservedCallback = (worker: WorkerSummary) => void

function createInboxEvent(
  state: PluginState,
  kind: InboxEvent["kind"],
  resourceId: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
): InboxEvent {
  return {
    id: `evt-${state.eventCounter + 1}-${kind}-${resourceId}`,
    kind,
    resourceId,
    blocking: kind === "permission.requested",
    summary,
    read: false,
    timestamp: Date.now(),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled daemon event: ${JSON.stringify(value)}`)
}

function workerFromAgent(state: PluginState, agent: AgentSummary): WorkerSummary {
  const current = state.workers.get(agent.id)
  const worker = mapAgentToWorkerSummary(agent)
  worker.unreadEventCount = getUnreadEventCountForResource(state, worker.id)
  if (!worker.chatRoom && current?.chatRoom) worker.chatRoom = current.chatRoom
  return worker
}

function handlePermissionRequested(state: PluginState, event: PermissionRequestedEvent): void {
  const worker = state.workers.get(event.payload.workerId)
  const permId = event.payload.permissionId
  if (!worker) return

  worker.requiresAttention = true
  worker.attentionReason = "permission"
  if (permId && !worker.pendingPermissionIds.includes(permId)) {
    worker.pendingPermissionIds = [...worker.pendingPermissionIds, permId]
    worker.pendingPermissions = [...worker.pendingPermissions, event.payload.request]
  }
}

function handlePermissionResolved(state: PluginState, event: PermissionResolvedEvent): void {
  const permId = event.payload.permissionId
  markEventRead(state, getHydrationPermissionEventId(permId))

  for (const [id, inboxEvent] of state.inbox) {
    if (
      inboxEvent.kind === "permission.requested" &&
      inboxEvent.resourceId === event.payload.workerId &&
      inboxEvent.metadata?.permissionId === permId &&
      !inboxEvent.read
    ) {
      markEventRead(state, id)
    }
  }

  const worker = state.workers.get(event.payload.workerId)
  if (!worker) return

  worker.pendingPermissionIds = worker.pendingPermissionIds.filter((id) => id !== permId)
  worker.pendingPermissions = worker.pendingPermissions.filter((permission) => permission.id !== permId)
  if (worker.pendingPermissionIds.length === 0 && worker.attentionReason === "permission") {
    worker.requiresAttention = false
    worker.attentionReason = null
  }
}

/**
 * Create a daemon event handler that updates plugin state and inbox items.
 *
 * @param state In-memory plugin state used to sync workers, sessions, and inbox items.
 * @param logger Logger used for daemon event reporting.
 * @param config Plugin configuration used for summary limits and nudge behavior.
 * @param opencodeClient Optional OpenCode client used to deliver nudges.
 * @param onWorkerObserved Optional callback invoked when a worker is observed.
 * @param onTaskWorkerObserved Optional callback invoked when a task worker is observed.
 * @returns A daemon event handler that processes incoming daemon events.
 */
export function createDaemonEventHandler(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  opencodeClient?: OpencodeClient,
  onWorkerObserved?: WorkerObservedCallback,
  onTaskWorkerObserved?: TaskWorkerObservedCallback,
) {
  return (daemonEvent: DaemonEvent) => {
    const inboxEvent = handleDaemonEvent(state, logger, config, daemonEvent, onWorkerObserved, onTaskWorkerObserved)
    insertAndNotifyInboxEvent(state, logger, config, opencodeClient, inboxEvent)
  }
}

function handleDaemonEvent(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  daemonEvent: DaemonEvent,
  onWorkerObserved?: WorkerObservedCallback,
  onTaskWorkerObserved?: TaskWorkerObservedCallback,
): InboxEvent | null {
  switch (daemonEvent.type) {
    case "agent_update":
      return handleAgentUpdate(state, config, daemonEvent, onWorkerObserved, onTaskWorkerObserved)
    case "agent_deleted":
      removeWorkerFromState(state, daemonEvent.payload.agentId)
      return null
    case "agent_permission_request":
      return handlePermissionRequestedEvent(state, config, daemonEvent)
    case "agent_permission_resolved":
      handlePermissionResolved(state, daemonEvent)
      return null
    default:
      return handleNonAgentDaemonEvent(state, logger, config, daemonEvent)
  }
}

function handleNonAgentDaemonEvent(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  daemonEvent: Exclude<
    DaemonEvent,
    Extract<
      DaemonEvent,
      { type: "agent_update" | "agent_deleted" | "agent_permission_request" | "agent_permission_resolved" }
    >
  >,
): InboxEvent | null {
  switch (daemonEvent.type) {
    case "terminal.exited":
      return handleTerminalExited(state, daemonEvent)
    case "daemon.connected":
    case "daemon.disconnected":
    case "daemon.error":
      return handleDaemonLifecycleEvent(state, logger, config, daemonEvent)
    case "agent_stream":
      return null
    case "worker.stalled":
      return handleWorkerStalled(state, config, daemonEvent)
    default:
      assertNever(daemonEvent)
  }
}

function handleDaemonLifecycleEvent(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  daemonEvent: Extract<DaemonEvent, { type: "daemon.connected" | "daemon.disconnected" | "daemon.error" }>,
): InboxEvent | null {
  switch (daemonEvent.type) {
    case "daemon.connected":
      return handleDaemonConnected(state, logger, config)
    case "daemon.disconnected":
      return handleDaemonDisconnected(state, logger, config)
    case "daemon.error":
      return handleDaemonError(state, logger, daemonEvent)
  }
}

function handleTerminalExited(
  state: PluginState,
  daemonEvent: Extract<DaemonEvent, { type: "terminal.exited" }>,
): null {
  const terminal = state.terminals.get(daemonEvent.payload.terminalId)
  if (terminal) terminal.status = "exited"
  return null
}

function handleDaemonConnected(state: PluginState, logger: Logger, config: PluginConfig): InboxEvent {
  setConnectionStatus(state, "connected")
  logger.info("Daemon connected")
  return createInboxEvent(
    state,
    "daemon.connected",
    "daemon",
    truncateSummary("Daemon connected", config.output.maxSummaryLength),
    undefined,
  )
}

function handleDaemonDisconnected(state: PluginState, logger: Logger, config: PluginConfig): InboxEvent {
  setConnectionStatus(state, "error", "Daemon disconnected")
  logger.warn("Daemon disconnected")
  return createInboxEvent(
    state,
    "daemon.disconnected",
    "daemon",
    truncateSummary("Daemon disconnected", config.output.maxSummaryLength),
    undefined,
  )
}

function handleDaemonError(
  state: PluginState,
  logger: Logger,
  daemonEvent: Extract<DaemonEvent, { type: "daemon.error" }>,
): null {
  setConnectionStatus(state, "error", daemonEvent.payload.message)
  logger.error("Daemon error event", { message: daemonEvent.payload.message })
  return null
}

function handleAgentUpdate(
  state: PluginState,
  config: PluginConfig,
  daemonEvent: Extract<DaemonEvent, { type: "agent_update" }>,
  onWorkerObserved?: WorkerObservedCallback,
  onTaskWorkerObserved?: TaskWorkerObservedCallback,
): InboxEvent | null {
  if (daemonEvent.payload.kind === "remove") {
    removeWorkerFromState(state, daemonEvent.payload.agentId)
    return null
  }

  const previous = state.workers.get(daemonEvent.payload.agent.id)
  const worker = workerFromAgent(state, daemonEvent.payload.agent)
  upsertWorker(state, worker)

  const taskBound = bindTaskWorkerFromAgent(state, worker, daemonEvent.payload.agent)
  if (taskBound) onTaskWorkerObserved?.(worker)
  onWorkerObserved?.(worker, getWorkerLaunchIdFromLabels(daemonEvent.payload.agent.labels))

  return deriveAgentUpdateInboxEvent(state, config, previous, worker)
}

function bindTaskWorkerFromAgent(state: PluginState, worker: WorkerSummary, agent: AgentSummary): boolean {
  const taskInfo = getTaskLabelInfo(agent.labels)
  if (!taskInfo) return false
  getOrCreateSession(state, taskInfo.taskSessionId, worker.cwd)
  getOrCreateSession(state, taskInfo.parentSessionId, worker.cwd)
  recordCreatedWorker(state, taskInfo.taskSessionId, worker)
  recordCreatedWorker(state, taskInfo.parentSessionId, worker)
  const existing = getTaskRun(state, taskInfo.taskSessionId)
  const taskRun = taskRunRecordFromAgent(worker, agent.labels, taskInfo, existing)
  recordTaskRun(state, taskRun)
  if (taskRun.background) {
    recordBackgroundWorker(state, taskRun.taskSessionId, worker.id)
    recordBackgroundWorker(state, taskRun.parentSessionId, worker.id)
  }
  return true
}

function taskRunRecordFromAgent(
  worker: WorkerSummary,
  labels: Record<string, string>,
  taskInfo: NonNullable<ReturnType<typeof getTaskLabelInfo>>,
  existing: TaskRunRecord | undefined,
): TaskRunRecord {
  const completionInjected = existing?.completionInjected ?? taskInfo.completionInjected
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

function taskBackground(
  existing: TaskRunRecord | undefined,
  taskInfo: NonNullable<ReturnType<typeof getTaskLabelInfo>>,
  completionInjected: boolean | undefined,
): boolean {
  return existing?.background ?? (taskInfo.deferred === true && completionInjected !== true)
}

function deriveAgentUpdateInboxEvent(
  state: PluginState,
  config: PluginConfig,
  previous: WorkerSummary | undefined,
  worker: WorkerSummary,
): InboxEvent | null {
  if (findSessionsForResource(state, worker.id).length === 0) return null
  if (isActionableStatusTransition(previous, worker)) {
    return createInboxEvent(state, "agent.status", worker.id, statusSummary(worker, config), {
      workerId: worker.id,
      status: worker.status,
      previousStatus: previous?.status ?? null,
    })
  }
  if (workerRequiresNonPermissionAttention(worker, previous)) {
    return createInboxEvent(state, "agent.attention", worker.id, attentionSummary(worker, config), {
      workerId: worker.id,
      status: worker.status,
      attentionReason: worker.attentionReason,
    })
  }
  return null
}

function workerRequiresNonPermissionAttention(worker: WorkerSummary, previous: WorkerSummary | undefined): boolean {
  if (!worker.requiresAttention) return false
  if (worker.attentionReason === "permission" || worker.pendingPermissionIds.length > 0) return false
  return previous?.requiresAttention !== true || previous.attentionReason !== worker.attentionReason
}

function isActionableStatusTransition(previous: WorkerSummary | undefined, worker: WorkerSummary): boolean {
  if (previous?.status === worker.status) return false
  return worker.status === "idle" || worker.status === "error" || worker.status === "closed"
}

function attentionSummary(worker: WorkerSummary, config: PluginConfig): string {
  return truncateSummary(
    worker.attentionReason ?? `Worker "${worker.title}" requires attention`,
    config.output.maxSummaryLength,
  )
}

function statusSummary(worker: WorkerSummary, config: PluginConfig): string {
  return truncateSummary(`Worker "${worker.title}" is ${worker.status}`, config.output.maxSummaryLength)
}

function handleWorkerStalled(
  state: PluginState,
  config: PluginConfig,
  daemonEvent: Extract<DaemonEvent, { type: "worker.stalled" }>,
): InboxEvent {
  const resourceId = daemonEvent.payload.workerId
  const summary = truncateSummary(
    (typeof daemonEvent.payload.summary === "string" && daemonEvent.payload.summary) ||
      `worker.stalled for ${resourceId}`,
    config.output.maxSummaryLength,
  )
  return createInboxEvent(state, "worker.stalled", resourceId, summary, daemonEvent.payload)
}

function handlePermissionRequestedEvent(
  state: PluginState,
  config: PluginConfig,
  daemonEvent: PermissionRequestedEvent,
): InboxEvent {
  handlePermissionRequested(state, daemonEvent)
  const resourceId = daemonEvent.payload.workerId
  const summary = truncateSummary(
    permissionRequestSummary(daemonEvent.payload.request, resourceId),
    config.output.maxSummaryLength,
  )
  return createInboxEvent(state, "permission.requested", resourceId, summary, {
    ...daemonEvent.payload,
    ...buildBlockingMetadata("permission.requested", resourceId, { permissionId: daemonEvent.payload.permissionId }),
  })
}

function permissionRequestSummary(request: Record<string, unknown>, workerId: string): string {
  const summary = request.summary ?? request.message ?? request.title ?? request.description
  return typeof summary === "string" && summary.trim() ? summary : `Permission requested by worker ${workerId}`
}

function insertAndNotifyInboxEvent(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  opencodeClient: OpencodeClient | undefined,
  inboxEvent: InboxEvent | null,
): void {
  if (!inboxEvent) return
  if (!insertInboxEvent(state, inboxEvent, config.output.maxInboxItems)) return
  logger.info("Inbox event inserted", {
    kind: inboxEvent.kind,
    resourceId: inboxEvent.resourceId,
    blocking: inboxEvent.blocking,
  })
  notifyInboxEvent(state, logger, config, opencodeClient, inboxEvent)
}

function notifyInboxEvent(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  opencodeClient: OpencodeClient | undefined,
  inboxEvent: InboxEvent,
): void {
  if (!opencodeClient || !config.nudgeEnabled) return
  const sessionIds = findBackgroundSessionsForResource(state, inboxEvent.resourceId)
  if (sessionIds.length === 0) return
  sendNudge(
    opencodeClient,
    sessionIds,
    formatNudgeMessage(inboxEvent.kind, inboxEvent.resourceId, inboxEvent.summary),
    logger,
  )
}
