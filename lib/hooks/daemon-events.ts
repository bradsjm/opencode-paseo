import type { PluginConfig } from "../config.js"
import { getHydrationPermissionEventId } from "../inbox/ids.js"
import { truncateSummary } from "../inbox/summary.js"
import type { Logger } from "../logger.js"
import { shouldNudge, formatNudgeMessage, sendNudge } from "../notifier.js"
import {
  buildBlockingMetadata,
  findSessionsForResource,
  getUnreadEventCountForResource,
  getOrCreateSession,
  getTaskRun,
  insertInboxEvent,
  markEventRead,
  mapAgentToWorkerSummary,
  recordCreatedWorker,
  recordTaskRun,
  setConnectionStatus,
  upsertWorker,
} from "../state/state.js"
import type { InboxEvent, PluginState, TaskRunRecord, WorkerSummary } from "../state/types.js"
import type {
  AgentSummary,
  DaemonEvent,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
  WorkerBlockedEvent,
  WorkerEventPayload,
  WorkerFailedEvent,
  WorkerFinishedEvent,
  WorkerStartedEvent,
} from "../transport/types.js"
import type { OpencodeClient } from "../profile.js"
import { getWorkerLaunchIdFromLabels } from "../worker-launch/queue.js"
import { getTaskLabelInfo } from "../task-labels.js"

function syncWorkerFromPayload(
  state: PluginState,
  type:
    | WorkerStartedEvent["type"]
    | WorkerFinishedEvent["type"]
    | WorkerFailedEvent["type"]
    | WorkerBlockedEvent["type"],
  payload: WorkerEventPayload,
): WorkerSummary {
  const workerId = payload.workerId
  const current = state.workers.get(workerId)
  const agent = payload.agent as Record<string, unknown> | undefined
  const merged = mergeAgentSummary(workerId, current, agent)

  const worker = mapAgentToWorkerSummary(merged)
  worker.unreadEventCount = getUnreadEventCountForResource(state, workerId)
  preserveCurrentChatRoom(worker, current)

  applyStatusFallback(worker, type, agent)

  upsertWorker(state, worker)
  return worker
}

function mergeAgentSummary(
  workerId: string,
  current: WorkerSummary | undefined,
  agent: Record<string, unknown> | undefined,
): AgentSummary {
  return {
    ...mergeAgentCoreFields(workerId, current, agent),
    ...mergeAttentionFields(agent),
    ...mergeCapabilityFields(agent),
    ...mergeRuntimeFields(agent, current),
    ...mergeWorktreeFields(agent, current),
    ...mergeTimestampFields(agent, current),
  }
}

function mergeAgentCoreFields(
  workerId: string,
  current: WorkerSummary | undefined,
  agent: Record<string, unknown> | undefined,
): Pick<AgentSummary, "id" | "provider" | "cwd" | "model" | "status" | "title" | "labels" | "pendingPermissions"> {
  return {
    id: workerId,
    provider: stringFieldWithDefault(agent, current, "provider", "provider", "unknown"),
    cwd: stringFieldWithDefault(agent, current, "cwd", "cwd", ""),
    model: modelField(agent, current),
    status: stringField(agent, "status") ?? current?.status ?? "unknown",
    title: titleField(agent, current),
    labels: labelsField(agent, current),
    pendingPermissions: pendingPermissionsField(agent, current),
  }
}

function stringFieldWithDefault(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
  agentKey: string,
  currentKey: "provider" | "cwd",
  fallback: string,
): string {
  return stringField(agent, agentKey) || current?.[currentKey] || fallback
}

function modelField(agent: Record<string, unknown> | undefined, current: WorkerSummary | undefined): string | null {
  return stringField(agent, "model") || current?.model || null
}

function titleField(agent: Record<string, unknown> | undefined, current: WorkerSummary | undefined): string | null {
  return stringField(agent, "title") || current?.title || null
}

function labelsField(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
): Record<string, string> {
  if (agent?.labels && typeof agent.labels === "object" && !Array.isArray(agent.labels)) {
    return agent.labels as Record<string, string>
  }
  return Object.fromEntries((current?.labels ?? []).map((label) => [label, label]))
}

function pendingPermissionsField(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
): Array<Record<string, unknown>> {
  return (agent?.pendingPermissions as Array<Record<string, unknown>>) ?? current?.pendingPermissions ?? []
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function mergeAttentionFields(agent: Record<string, unknown> | undefined): Partial<AgentSummary> {
  return {
    ...(typeof agent?.requiresAttention === "boolean" ? { requiresAttention: agent.requiresAttention } : {}),
    ...(agent?.attentionReason !== undefined ? { attentionReason: agent.attentionReason as string | null } : {}),
  }
}

function mergeCapabilityFields(agent: Record<string, unknown> | undefined): Partial<AgentSummary> {
  return agent?.capabilities !== undefined ? { capabilities: agent.capabilities as Record<string, unknown> } : {}
}

function mergeRuntimeFields(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
): Partial<AgentSummary> {
  if (agent?.runtimeInfo !== undefined) return { runtimeInfo: agent.runtimeInfo as Record<string, unknown> }
  return current?.runtimeInfo !== null && current?.runtimeInfo !== undefined ? { runtimeInfo: current.runtimeInfo } : {}
}

function mergeWorktreeFields(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
): Partial<AgentSummary> {
  return {
    ...optionalStringField("worktreePath", stringField(agent, "worktreePath") || current?.worktreePath),
    ...optionalStringField("branchName", stringField(agent, "branchName") || current?.branchName),
  }
}

function mergeTimestampFields(
  agent: Record<string, unknown> | undefined,
  current: WorkerSummary | undefined,
): Partial<AgentSummary> {
  return {
    ...optionalStringField("createdAt", stringField(agent, "createdAt") ?? current?.createdAt),
    ...optionalStringField("updatedAt", stringField(agent, "updatedAt") ?? current?.updatedAt),
  }
}

function optionalStringField(
  key: "worktreePath" | "branchName" | "createdAt" | "updatedAt",
  value: string | undefined,
) {
  return value ? { [key]: value } : {}
}

function preserveCurrentChatRoom(worker: WorkerSummary, current: WorkerSummary | undefined): void {
  if (!worker.chatRoom && current?.chatRoom) worker.chatRoom = current.chatRoom
}

function applyStatusFallback(
  worker: WorkerSummary,
  type: DaemonEvent["type"],
  agent: Record<string, unknown> | undefined,
): void {
  if (agent?.status) return
  if (type === "worker.finished") worker.status = "finished"
  if (type === "worker.failed") worker.status = "failed"
  if (type === "worker.blocked") worker.status = "blocked"
}

function getWorkerEventSummary(
  type: DaemonEvent["type"],
  resourceId: string,
  payload: Record<string, unknown>,
): string {
  const rawSummary =
    (typeof payload.summary === "string" && payload.summary) ||
    (typeof payload.message === "string" && payload.message) ||
    (type === "daemon.connected"
      ? "Daemon connected"
      : type === "daemon.disconnected"
        ? "Daemon disconnected"
        : `${type} for ${resourceId}`)

  return rawSummary
}

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
    blocking: kind === "worker.blocked" || kind === "permission.requested",
    summary,
    read: false,
    timestamp: Date.now(),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled daemon event: ${JSON.stringify(value)}`)
}

function handlePermissionRequested(state: PluginState, event: PermissionRequestedEvent): void {
  const worker = state.workers.get(event.payload.workerId)
  const permId = event.payload.permissionId
  if (!worker || !permId || worker.pendingPermissionIds.includes(permId)) {
    return
  }

  worker.pendingPermissionIds = [...worker.pendingPermissionIds, permId]
  worker.pendingPermissions = [...worker.pendingPermissions, event.payload.request]
}

function handlePermissionResolved(state: PluginState, event: PermissionResolvedEvent): void {
  const permId = event.payload.permissionId
  markEventRead(state, getHydrationPermissionEventId(permId))

  for (const [id, inboxEvent] of state.inbox) {
    if (
      inboxEvent.kind === "permission.requested" &&
      inboxEvent.resourceId === event.payload.workerId &&
      !inboxEvent.read
    ) {
      markEventRead(state, id)
    }
  }

  const worker = state.workers.get(event.payload.workerId)
  if (!worker) {
    return
  }

  worker.pendingPermissionIds = worker.pendingPermissionIds.filter((id) => id !== permId)
  worker.pendingPermissions = worker.pendingPermissions.filter((permission) => permission.id !== permId)
}

export function createDaemonEventHandler(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  opencodeClient?: OpencodeClient,
  onWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>, observedLaunchId?: string) => void,
  onTaskWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>) => void,
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
  onWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>, observedLaunchId?: string) => void,
  onTaskWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>) => void,
): InboxEvent | null {
  if (isWorkerLifecycleEvent(daemonEvent))
    return handleWorkerLifecycleEvent(state, config, daemonEvent, onWorkerObserved, onTaskWorkerObserved)
  if (daemonEvent.type === "permission.requested") return handlePermissionRequestedEvent(state, config, daemonEvent)
  if (daemonEvent.type === "permission.resolved") return handlePermissionResolvedEvent(state, config, daemonEvent)
  switch (daemonEvent.type) {
    case "terminal.exited":
      return handleTerminalExited(state, daemonEvent)
    case "daemon.connected":
      return handleDaemonConnected(state, logger, config)
    case "daemon.disconnected":
      return handleDaemonDisconnected(state, logger, config)
    case "daemon.error":
      return handleDaemonError(state, logger, daemonEvent)
    case "worker.activity":
      return null
    default:
      assertNever(daemonEvent)
  }
}

function isWorkerLifecycleEvent(
  daemonEvent: DaemonEvent,
): daemonEvent is
  | WorkerStartedEvent
  | Extract<DaemonEvent, { type: "worker.stalled" }>
  | WorkerFinishedEvent
  | WorkerFailedEvent
  | WorkerBlockedEvent {
  return (
    daemonEvent.type === "worker.started" ||
    daemonEvent.type === "worker.stalled" ||
    daemonEvent.type === "worker.finished" ||
    daemonEvent.type === "worker.failed" ||
    daemonEvent.type === "worker.blocked"
  )
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

function handleWorkerLifecycleEvent(
  state: PluginState,
  config: PluginConfig,
  daemonEvent:
    | WorkerStartedEvent
    | Extract<DaemonEvent, { type: "worker.stalled" }>
    | WorkerFinishedEvent
    | WorkerFailedEvent
    | WorkerBlockedEvent,
  onWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>, observedLaunchId?: string) => void,
  onTaskWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>) => void,
): InboxEvent {
  if (daemonEvent.type !== "worker.stalled")
    observeWorkerLifecyclePayload(state, daemonEvent, onWorkerObserved, onTaskWorkerObserved)
  const resourceId = daemonEvent.payload.workerId
  const summary = summarizeDaemonEvent(config, daemonEvent.type, resourceId, daemonEvent.payload)
  return createInboxEvent(state, daemonEvent.type, resourceId, summary, workerLifecycleMetadata(daemonEvent))
}

function observeWorkerLifecyclePayload(
  state: PluginState,
  daemonEvent: WorkerStartedEvent | WorkerFinishedEvent | WorkerFailedEvent | WorkerBlockedEvent,
  onWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>, observedLaunchId?: string) => void,
  onTaskWorkerObserved?: (worker: NonNullable<ReturnType<typeof syncWorkerFromPayload>>) => void,
): void {
  const worker = syncWorkerFromPayload(state, daemonEvent.type, daemonEvent.payload)
  const taskBound = bindTaskWorkerFromPayload(state, worker, daemonEvent.payload)
  if (taskBound) onTaskWorkerObserved?.(worker)
  const observedLaunchId = getWorkerLaunchIdFromLabels(
    (daemonEvent.payload.agent as Record<string, unknown> | undefined)?.labels,
  )
  onWorkerObserved?.(worker, observedLaunchId)
}

function bindTaskWorkerFromPayload(state: PluginState, worker: WorkerSummary, payload: WorkerEventPayload): boolean {
  const labels =
    ((payload.agent as Record<string, unknown> | undefined)?.labels as Record<string, string> | undefined) ?? {}
  const taskInfo = getTaskLabelInfo(labels)
  if (!taskInfo) return false
  getOrCreateSession(state, taskInfo.taskSessionId, worker.cwd)
  getOrCreateSession(state, taskInfo.parentSessionId, worker.cwd)
  recordCreatedWorker(state, taskInfo.taskSessionId, worker)
  recordCreatedWorker(state, taskInfo.parentSessionId, worker)
  const existing = getTaskRun(state, taskInfo.taskSessionId)
  recordTaskRun(state, taskRunRecordFromWorkerPayload(worker, labels, taskInfo, existing))
  return true
}

function taskRunRecordFromWorkerPayload(
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

function workerLifecycleMetadata(
  daemonEvent:
    | WorkerStartedEvent
    | Extract<DaemonEvent, { type: "worker.stalled" }>
    | WorkerFinishedEvent
    | WorkerFailedEvent
    | WorkerBlockedEvent,
) {
  if (daemonEvent.type !== "worker.blocked") return daemonEvent.payload
  return { ...daemonEvent.payload, ...buildBlockingMetadata("worker.blocked", daemonEvent.payload.workerId) }
}

function handlePermissionRequestedEvent(
  state: PluginState,
  config: PluginConfig,
  daemonEvent: PermissionRequestedEvent,
): InboxEvent {
  handlePermissionRequested(state, daemonEvent)
  const resourceId = daemonEvent.payload.workerId
  const summary = summarizeDaemonEvent(config, daemonEvent.type, resourceId, daemonEvent.payload)
  return createInboxEvent(state, daemonEvent.type, resourceId, summary, {
    ...daemonEvent.payload,
    ...buildBlockingMetadata("permission.requested", resourceId, { permissionId: daemonEvent.payload.permissionId }),
  })
}

function handlePermissionResolvedEvent(
  state: PluginState,
  config: PluginConfig,
  daemonEvent: PermissionResolvedEvent,
): InboxEvent {
  handlePermissionResolved(state, daemonEvent)
  const resourceId = daemonEvent.payload.workerId
  return createInboxEvent(
    state,
    daemonEvent.type,
    resourceId,
    summarizeDaemonEvent(config, daemonEvent.type, resourceId, daemonEvent.payload),
    daemonEvent.payload,
  )
}

function summarizeDaemonEvent(
  config: PluginConfig,
  type: DaemonEvent["type"],
  resourceId: string,
  payload: Record<string, unknown>,
): string {
  return truncateSummary(getWorkerEventSummary(type, resourceId, payload), config.output.maxSummaryLength)
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
  if (!opencodeClient || !shouldNudge(inboxEvent.kind, config.notifications)) return
  const sessionIds = findSessionsForResource(state, inboxEvent.resourceId)
  if (sessionIds.length === 0) return
  sendNudge(
    opencodeClient,
    sessionIds,
    formatNudgeMessage(inboxEvent.kind, inboxEvent.resourceId, inboxEvent.summary),
    logger,
  )
}
