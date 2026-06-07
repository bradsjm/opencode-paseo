import type {
  PluginState,
  SessionMapping,
  ConnectionStatus,
  CapabilitySnapshot,
  TerminalSessionSummary,
  EphemeralWorkerRunRecord,
  TaskRunRecord,
  WorkerSummary,
} from "./types.js"
import type { AgentSummary } from "../transport/types.js"
import { getChatRoomFromAgentLabels } from "../chat/worker-room.js"
import { mapDaemonWorkerStatus } from "./status.js"

const INTERNAL_WORKER_LABEL_PREFIX = "opencodePaseo."

/** Re-export inbox state helpers for public state consumers. */
export {
  insertInboxEvent,
  markEventRead,
  markAllRead,
  findSessionsForResource,
  findBackgroundSessionsForResource,
  buildBlockingMetadata,
  getBlockingAction,
  getUnreadEventCountForResource,
  markUnreadStallEventsRead,
  markResourceEventsRead,
} from "./inbox-state.js"

/**
 * Create a new session mapping with fresh binding and inbox state.
 *
 * @param opencodeSessionId - OpenCode session ID to associate with the mapping.
 * @param projectRoot - Root directory for the associated project.
 * @returns A new session mapping.
 */
export function createSessionMapping(opencodeSessionId: string, projectRoot: string): SessionMapping {
  const now = Date.now()
  return {
    opencodeSessionId,
    projectRoot,
    createdTerminalIds: new Set(),
    createdWorkerIds: new Set(),
    backgroundWorkerIds: new Set(),
    unreadEvents: new Map(),
    pendingPermissions: new Map(),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Create a clean plugin state snapshot.
 *
 * @returns A newly initialized plugin state.
 */
export function createPluginState(): PluginState {
  return {
    connectionStatus: "disconnected",
    lastError: undefined,
    capabilities: null,
    sessions: new Map(),
    terminals: new Map(),
    workers: new Map(),
    chatRooms: new Map(),
    inbox: new Map(),
    workerLaunches: new Map(),
    ephemeralWorkerRuns: new Map(),
    taskRuns: new Map(),
    taskCompletionWatchers: new Set(),
    workerLaunchQueue: [],
    activeWorkerLaunchId: null,
    eventCounter: 0,
  }
}

/**
 * Reset an existing plugin state object back to its initial values.
 *
 * @param state - Plugin state to reset in place.
 * @returns Nothing.
 */
export function resetPluginState(state: PluginState): void {
  state.connectionStatus = "disconnected"
  state.lastError = undefined
  state.capabilities = null
  state.sessions.clear()
  state.terminals.clear()
  state.workers.clear()
  state.chatRooms.clear()
  state.inbox.clear()
  state.workerLaunches.clear()
  state.ephemeralWorkerRuns.clear()
  state.taskRuns.clear()
  state.taskCompletionWatchers.clear()
  state.workerLaunchQueue = []
  state.activeWorkerLaunchId = null
  state.eventCounter = 0
}

/**
 * Update the daemon connection status and optional last error.
 *
 * @param state - Plugin state to update.
 * @param status - New connection status.
 * @param error - Optional connection error message.
 * @returns Nothing.
 */
export function setConnectionStatus(state: PluginState, status: ConnectionStatus, error?: string): void {
  state.connectionStatus = status
  if (error !== undefined) {
    state.lastError = error
  } else if (status === "connected") {
    state.lastError = undefined
  }
}

/**
 * Store a fresh capability snapshot on plugin state.
 *
 * @param state - Plugin state to update.
 * @param caps - Capability snapshot to store.
 * @returns Nothing.
 */
export function setCapabilities(state: PluginState, caps: CapabilitySnapshot): void {
  state.capabilities = caps
}

/**
 * Get an existing session mapping or create one on demand.
 *
 * @param state - Plugin state to read from and update.
 * @param sessionId - OpenCode session ID to look up.
 * @param projectRoot - Project root to record for a new mapping.
 * @returns The existing or newly created session mapping.
 */
export function getOrCreateSession(state: PluginState, sessionId: string, projectRoot: string): SessionMapping {
  let mapping = state.sessions.get(sessionId)
  if (!mapping) {
    mapping = createSessionMapping(sessionId, projectRoot)
    state.sessions.set(sessionId, mapping)
  }
  return mapping
}

// ─── Terminal / Worker Updates ───────────────────────────────────────────────

/**
 * Insert or replace a terminal summary in global state.
 *
 * @param state - Plugin state to update.
 * @param terminal - Terminal summary to store.
 * @returns Nothing.
 */
export function upsertTerminal(state: PluginState, terminal: TerminalSessionSummary): void {
  state.terminals.set(terminal.id, terminal)
}

/**
 * Insert or replace a worker summary in global state.
 *
 * @param state - Plugin state to update.
 * @param worker - Worker summary to store.
 * @returns Nothing.
 */
export function upsertWorker(state: PluginState, worker: WorkerSummary): void {
  state.workers.set(worker.id, worker)
  if (worker.chatRoom) {
    const existing = state.chatRooms.get(worker.chatRoom)
    if (!existing) {
      state.chatRooms.set(worker.chatRoom, {
        name: worker.chatRoom,
        lastMessageId: null,
        seededAt: null,
        watching: false,
      })
    }
  }
}

// ─── Session-Terminal Binding ────────────────────────────────────────────────
/**
 * Record a terminal as created by a session and bind it for inbox routing.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID that created the terminal.
 * @param terminal - Terminal summary to register.
 * @returns Nothing.
 */
export function recordCreatedTerminal(state: PluginState, sessionId: string, terminal: TerminalSessionSummary): void {
  state.terminals.set(terminal.id, terminal)
  const session = state.sessions.get(sessionId)
  if (session) {
    session.createdTerminalIds.add(terminal.id)
    session.updatedAt = Date.now()
  }
}

// ─── Session-Worker Binding ─────────────────────────────────────────────────────
/**
 * Record a worker as created by a session and bind it for inbox routing.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID that created the worker.
 * @param worker - Worker summary to register.
 * @returns Nothing.
 */
export function recordCreatedWorker(state: PluginState, sessionId: string, worker: WorkerSummary): void {
  upsertWorker(state, worker)
  const session = state.sessions.get(sessionId)
  if (session) {
    session.createdWorkerIds.add(worker.id)
    session.updatedAt = Date.now()
  }
}

/**
 * Mark a created worker as background work for the owning session.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID that owns the worker.
 * @param workerId - Worker ID to mark as background work.
 * @returns Nothing.
 */
export function recordBackgroundWorker(state: PluginState, sessionId: string, workerId: string): void {
  const session = state.sessions.get(sessionId)
  if (!session || !session.createdWorkerIds.has(workerId)) return
  session.backgroundWorkerIds.add(workerId)
  session.updatedAt = Date.now()
}

/**
 * Remove a worker from the background-worker set for a session.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID that owns the worker.
 * @param workerId - Worker ID to remove from background tracking.
 * @returns Nothing.
 */
export function unrecordBackgroundWorker(state: PluginState, sessionId: string, workerId: string): void {
  const session = state.sessions.get(sessionId)
  if (!session) return
  session.backgroundWorkerIds.delete(workerId)
  session.updatedAt = Date.now()
}

/**
 * Store an ephemeral worker run record.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID associated with the run.
 * @param workerId - Worker ID for the run.
 * @param options - Ephemeral run options, including background mode and creation time.
 * @param options.background
 * @param options.createdAt
 * @returns Nothing.
 */
export function registerEphemeralWorkerRun(
  state: PluginState,
  sessionId: string,
  workerId: string,
  options: { background: boolean; createdAt?: number },
): void {
  state.ephemeralWorkerRuns.set(workerId, {
    workerId,
    sessionId,
    background: options.background,
    createdAt: options.createdAt ?? Date.now(),
  })
}

/**
 * Remove and return an ephemeral worker run record by worker ID.
 *
 * @param state - Plugin state to update.
 * @param workerId - Worker ID to remove.
 * @returns The removed run record, or `undefined` if none existed.
 */
export function removeEphemeralWorkerRun(state: PluginState, workerId: string): EphemeralWorkerRunRecord | undefined {
  const record = state.ephemeralWorkerRuns.get(workerId)
  state.ephemeralWorkerRuns.delete(workerId)
  return record
}

/**
 * Store a task-run record keyed by the visible task session ID.
 *
 * @param state - Plugin state to update.
 * @param record - Task run record to store.
 * @returns Nothing.
 */
export function recordTaskRun(state: PluginState, record: TaskRunRecord): void {
  state.taskRuns.set(record.taskSessionId, record)
}

/**
 * Look up a task-run record by task session ID.
 *
 * @param state - Plugin state to read from.
 * @param taskSessionId - Task session ID to look up.
 * @returns The matching task run record, or `undefined` if none exists.
 */
export function getTaskRun(state: PluginState, taskSessionId: string): TaskRunRecord | undefined {
  return state.taskRuns.get(taskSessionId)
}

/**
 * Remove and return a task-run record by task session ID.
 *
 * @param state - Plugin state to update.
 * @param taskSessionId - Task session ID to remove.
 * @returns The removed task run record, or `undefined` if none existed.
 */
export function removeTaskRun(state: PluginState, taskSessionId: string): TaskRunRecord | undefined {
  const record = state.taskRuns.get(taskSessionId)
  state.taskRuns.delete(taskSessionId)
  return record
}

/**
 * Find the task-run record associated with a worker ID.
 *
 * @param state - Plugin state to read from.
 * @param workerId - Worker ID to search for.
 * @returns The matching task run record, or `undefined` if none exists.
 */
export function findTaskRunByWorkerId(state: PluginState, workerId: string): TaskRunRecord | undefined {
  for (const taskRun of state.taskRuns.values()) {
    if (taskRun.workerId === workerId) return taskRun
  }
  return undefined
}

/**
 * List task-run records attached to a session or its parent session.
 *
 * @param state - Plugin state to read from.
 * @param sessionId - Session ID to match.
 * @returns Task run records associated with the session.
 */
export function listTaskRunsForSession(state: PluginState, sessionId: string): TaskRunRecord[] {
  return Array.from(state.taskRuns.values()).filter(
    (taskRun) => taskRun.taskSessionId === sessionId || taskRun.parentSessionId === sessionId,
  )
}

/**
 * List ephemeral worker IDs created for a session.
 *
 * @param state - Plugin state to read from.
 * @param sessionId - Session ID to match.
 * @returns Worker IDs for ephemeral runs created by the session.
 */
export function listEphemeralWorkerIdsForSession(state: PluginState, sessionId: string): string[] {
  const workerIds: string[] = []
  for (const run of state.ephemeralWorkerRuns.values()) {
    if (run.sessionId === sessionId) {
      workerIds.push(run.workerId)
    }
  }
  return workerIds
}

// ─── Session Lifecycle Helpers ───────────────────────────────────────────────

/**
 * Remove a session mapping and clear its session-scoped references.
 *
 * @param state - Plugin state to update.
 * @param sessionId - OpenCode session ID to remove.
 * @returns `true` when a session mapping was removed, otherwise `false`.
 */
export function removeSession(state: PluginState, sessionId: string): boolean {
  const session = state.sessions.get(sessionId)
  if (!session) return false

  // Clear session-scoped unread and pending maps
  session.unreadEvents.clear()
  session.pendingPermissions.clear()
  session.createdTerminalIds.clear()
  session.createdWorkerIds.clear()
  session.backgroundWorkerIds.clear()

  state.sessions.delete(sessionId)
  return true
}

/**
 * Remove a worker ID from every session binding.
 *
 * @param state - Plugin state to update.
 * @param workerId - Worker ID to unbind.
 * @returns Nothing.
 */
export function unbindWorkerFromSessions(state: PluginState, workerId: string): void {
  for (const session of state.sessions.values()) {
    session.createdWorkerIds.delete(workerId)
    session.backgroundWorkerIds.delete(workerId)
  }
}

/**
 * Remove a worker from local state and clear session-scoped references.
 *
 * @param state - Plugin state to update.
 * @param workerId - Worker ID to remove.
 * @returns Nothing.
 */
export function removeWorkerFromState(state: PluginState, workerId: string): void {
  state.workers.delete(workerId)

  for (const session of state.sessions.values()) {
    session.createdWorkerIds.delete(workerId)
    session.backgroundWorkerIds.delete(workerId)

    for (const [eventId, event] of session.unreadEvents.entries()) {
      if (event.resourceId === workerId) {
        session.unreadEvents.delete(eventId)
      }
    }

    for (const [eventId, event] of session.pendingPermissions.entries()) {
      if (event.resourceId === workerId) {
        session.pendingPermissions.delete(eventId)
      }
    }
  }
}

/**
 * Remove a terminal ID from every session binding.
 *
 * @param state - Plugin state to update.
 * @param terminalId - Terminal ID to unbind.
 * @returns Nothing.
 */
export function unbindTerminalFromSessions(state: PluginState, terminalId: string): void {
  for (const session of state.sessions.values()) {
    session.createdTerminalIds.delete(terminalId)
  }
}

// ─── Agent → WorkerSummary Mapper ────────────────────────────────────────────
/**
 * Map a transport-level agent summary into a normalized worker summary.
 *
 * @param agent - Transport-level agent summary to convert.
 * @returns A normalized worker summary.
 */
export function mapAgentToWorkerSummary(agent: AgentSummary): WorkerSummary {
  const pendingPermissions = agent.pendingPermissions ?? []
  return {
    ...workerIdentityFields(agent),
    status: mapDaemonWorkerStatus(workerStatusInput(agent, pendingPermissions)),
    ...workerLabelFields(agent),
    ...workerWorktreeFields(agent),
    pendingPermissions,
    pendingPermissionIds: pendingPermissionIdsForAgent(pendingPermissions),
    ...workerAttentionFields(agent),
    ...workerRuntimeFields(agent),
    ...workerTimestampFields(agent),
  }
}

function workerIdentityFields(
  agent: AgentSummary,
): Pick<WorkerSummary, "id" | "title" | "agent" | "provider" | "model" | "currentModeId" | "cwd" | "unreadEventCount"> {
  return {
    id: agent.id,
    title: agent.title ?? agent.model ?? agent.id,
    agent: agent.provider ?? "unknown",
    provider: agent.provider ?? "unknown",
    model: agent.model ?? null,
    currentModeId: currentModeIdForAgent(agent),
    cwd: agent.cwd ?? "",
    unreadEventCount: 0,
  }
}

function workerLabelFields(
  agent: AgentSummary,
): Pick<WorkerSummary, "labels"> & Partial<Pick<WorkerSummary, "rawStatus" | "chatRoom">> {
  const chatRoom = getChatRoomFromAgentLabels(agent.labels)
  return {
    ...(agent.status !== undefined ? { rawStatus: agent.status } : {}),
    labels: visibleWorkerLabels(agent.labels),
    ...(chatRoom !== undefined ? { chatRoom } : {}),
  }
}

function workerAttentionFields(agent: AgentSummary): Pick<WorkerSummary, "requiresAttention" | "attentionReason"> {
  return {
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
  }
}

function workerRuntimeFields(agent: AgentSummary): Pick<WorkerSummary, "runtimeInfo" | "persistence"> {
  return {
    runtimeInfo: agent.runtimeInfo ?? null,
    persistence: (agent.capabilities?.persistence as Record<string, unknown>) ?? null,
  }
}

function visibleWorkerLabels(rawLabels: unknown): string[] {
  if (Array.isArray(rawLabels)) return rawLabels.filter(isVisibleWorkerLabel)
  if (rawLabels && typeof rawLabels === "object") return Object.keys(rawLabels).filter(isVisibleWorkerLabel)
  return []
}

function isVisibleWorkerLabel(label: unknown): label is string {
  return typeof label === "string" && !label.startsWith(INTERNAL_WORKER_LABEL_PREFIX)
}

function pendingPermissionIdsForAgent(pendingPermissions: Array<Record<string, unknown>>): string[] {
  return pendingPermissions.map((permission) => permission?.id as string | undefined).filter(isString)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function currentModeIdForAgent(agent: AgentSummary): string | null {
  return (
    (agent.runtimeInfo?.currentModeId as string | undefined) ??
    (agent.capabilities?.currentModeId as string | undefined) ??
    null
  )
}

function workerStatusInput(agent: AgentSummary, pendingPermissions: Array<Record<string, unknown>>) {
  return {
    status: agent.status,
    ...(agent.requiresAttention !== undefined ? { requiresAttention: agent.requiresAttention } : {}),
    ...(agent.attentionReason !== undefined ? { attentionReason: agent.attentionReason } : {}),
    pendingPermissions,
  }
}

function workerWorktreeFields(agent: AgentSummary): Partial<WorkerSummary> {
  return {
    ...(agent.worktreePath !== undefined ? { worktreePath: agent.worktreePath } : {}),
    ...(agent.branchName !== undefined ? { branchName: agent.branchName } : {}),
  }
}

function workerTimestampFields(agent: AgentSummary): Partial<WorkerSummary> {
  return {
    ...(agent.createdAt !== undefined ? { createdAt: agent.createdAt } : {}),
    ...(agent.updatedAt !== undefined ? { updatedAt: agent.updatedAt } : {}),
  }
}
