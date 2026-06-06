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

export {
  insertInboxEvent,
  markEventRead,
  markAllRead,
  findSessionsForResource,
  buildBlockingMetadata,
  getBlockingAction,
  getUnreadEventCountForResource,
  markUnreadStallEventsRead,
  markResourceEventsRead,
} from "./inbox-state.js"

export function createSessionMapping(opencodeSessionId: string, projectRoot: string): SessionMapping {
  const now = Date.now()
  return {
    opencodeSessionId,
    projectRoot,
    createdTerminalIds: new Set(),
    createdWorkerIds: new Set(),
    unreadEvents: new Map(),
    pendingPermissions: new Map(),
    createdAt: now,
    updatedAt: now,
  }
}

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

export function setConnectionStatus(state: PluginState, status: ConnectionStatus, error?: string): void {
  state.connectionStatus = status
  if (error !== undefined) {
    state.lastError = error
  } else if (status === "connected") {
    state.lastError = undefined
  }
}

export function setCapabilities(state: PluginState, caps: CapabilitySnapshot): void {
  state.capabilities = caps
}

export function getOrCreateSession(state: PluginState, sessionId: string, projectRoot: string): SessionMapping {
  let mapping = state.sessions.get(sessionId)
  if (!mapping) {
    mapping = createSessionMapping(sessionId, projectRoot)
    state.sessions.set(sessionId, mapping)
  }
  return mapping
}

// ─── Terminal / Worker Updates ───────────────────────────────────────────────

export function upsertTerminal(state: PluginState, terminal: TerminalSessionSummary): void {
  state.terminals.set(terminal.id, terminal)
}

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
// Records a newly created terminal in both the global terminal map and the
// session's createdTerminalIds so that subsequent inbox events for this
// terminal are routed to the correct session.

export function recordCreatedTerminal(state: PluginState, sessionId: string, terminal: TerminalSessionSummary): void {
  state.terminals.set(terminal.id, terminal)
  const session = state.sessions.get(sessionId)
  if (session) {
    session.createdTerminalIds.add(terminal.id)
    session.updatedAt = Date.now()
  }
}

// ─── Session-Worker Binding ─────────────────────────────────────────────────────
// Records a newly created worker in both the global workers map and the
// session's createdWorkerIds so that subsequent inbox events for this
// worker are routed to the correct session.

export function recordCreatedWorker(state: PluginState, sessionId: string, worker: WorkerSummary): void {
  upsertWorker(state, worker)
  const session = state.sessions.get(sessionId)
  if (session) {
    session.createdWorkerIds.add(worker.id)
    session.updatedAt = Date.now()
  }
}

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

export function removeEphemeralWorkerRun(state: PluginState, workerId: string): EphemeralWorkerRunRecord | undefined {
  const record = state.ephemeralWorkerRuns.get(workerId)
  state.ephemeralWorkerRuns.delete(workerId)
  return record
}

export function recordTaskRun(state: PluginState, record: TaskRunRecord): void {
  state.taskRuns.set(record.taskSessionId, record)
}

export function getTaskRun(state: PluginState, taskSessionId: string): TaskRunRecord | undefined {
  return state.taskRuns.get(taskSessionId)
}

export function removeTaskRun(state: PluginState, taskSessionId: string): TaskRunRecord | undefined {
  const record = state.taskRuns.get(taskSessionId)
  state.taskRuns.delete(taskSessionId)
  return record
}

export function findTaskRunByWorkerId(state: PluginState, workerId: string): TaskRunRecord | undefined {
  for (const taskRun of state.taskRuns.values()) {
    if (taskRun.workerId === workerId) return taskRun
  }
  return undefined
}

export function listTaskRunsForSession(state: PluginState, sessionId: string): TaskRunRecord[] {
  return Array.from(state.taskRuns.values()).filter(
    (taskRun) => taskRun.taskSessionId === sessionId || taskRun.parentSessionId === sessionId,
  )
}

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
 * Remove a session mapping and clear its unread/pending references.
 * This is the canonical cleanup helper for session.deleted and dispose paths.
 * It does NOT delete global worker/terminal entries — only session bindings.
 */
export function removeSession(state: PluginState, sessionId: string): boolean {
  const session = state.sessions.get(sessionId)
  if (!session) return false

  // Clear session-scoped unread and pending maps
  session.unreadEvents.clear()
  session.pendingPermissions.clear()
  session.createdTerminalIds.clear()
  session.createdWorkerIds.clear()

  state.sessions.delete(sessionId)
  return true
}

/**
 * Remove a worker ID from all session bindings.
 * Used when a worker is archived or otherwise permanently removed.
 * Does NOT delete the worker from state.workers — caller handles that.
 */
export function unbindWorkerFromSessions(state: PluginState, workerId: string): void {
  for (const session of state.sessions.values()) {
    session.createdWorkerIds.delete(workerId)
  }
}

/**
 * Permanently remove a worker from local state and clear session-scoped
 * actionable references for that worker. Global inbox history is preserved.
 */
export function removeWorkerFromState(state: PluginState, workerId: string): void {
  state.workers.delete(workerId)

  for (const session of state.sessions.values()) {
    session.createdWorkerIds.delete(workerId)

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
 * Remove a terminal ID from all session bindings.
 * Used when a terminal is killed or otherwise permanently removed.
 * Does NOT delete the terminal from state.terminals — caller handles that.
 */
export function unbindTerminalFromSessions(state: PluginState, terminalId: string): void {
  for (const session of state.sessions.values()) {
    session.createdTerminalIds.delete(terminalId)
  }
}

// ─── Agent → WorkerSummary Mapper ────────────────────────────────────────────
// Shared mapper used by hydration, event syncing, and tool responses to
// produce a consistent WorkerSummary from a transport-level AgentSummary.

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
