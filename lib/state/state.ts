import type {
    PluginState,
    SessionMapping,
    ConnectionStatus,
    CapabilitySnapshot,
    TerminalSessionSummary,
    WorkerSummary,
} from "./types.js"
import type { AgentSummary } from "../transport/types.js"
import { mapDaemonWorkerStatus } from "./status.js"
export {
    insertInboxEvent,
    markEventRead,
    markAllRead,
    findSessionsForResource,
    buildBlockingMetadata,
    getBlockingAction,
} from "./inbox-state.js"

export function createSessionMapping(
    opencodeSessionId: string,
    projectRoot: string,
): SessionMapping {
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
        inbox: new Map(),
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
    state.inbox.clear()
    state.eventCounter = 0
}

export function setConnectionStatus(
    state: PluginState,
    status: ConnectionStatus,
    error?: string,
): void {
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

export function getOrCreateSession(
    state: PluginState,
    sessionId: string,
    projectRoot: string,
): SessionMapping {
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
}

// ─── Session-Terminal Binding ────────────────────────────────────────────────
// Records a newly created terminal in both the global terminal map and the
// session's createdTerminalIds so that subsequent inbox events for this
// terminal are routed to the correct session.

export function recordCreatedTerminal(
    state: PluginState,
    sessionId: string,
    terminal: TerminalSessionSummary,
): void {
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

export function recordCreatedWorker(
    state: PluginState,
    sessionId: string,
    worker: WorkerSummary,
): void {
    state.workers.set(worker.id, worker)
    const session = state.sessions.get(sessionId)
    if (session) {
        session.createdWorkerIds.add(worker.id)
        session.updatedAt = Date.now()
    }
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
    const rawLabels = agent.labels
    const labels: string[] = Array.isArray(rawLabels)
        ? rawLabels
        : rawLabels && typeof rawLabels === "object"
          ? Object.keys(rawLabels)
          : []

    const pendingPermissions = agent.pendingPermissions ?? []
    const pendingPermissionIds = pendingPermissions
        .map((p) => p?.id as string | undefined)
        .filter((id): id is string => typeof id === "string")

    return {
        id: agent.id,
        title: agent.title ?? agent.model ?? agent.id,
        agent: agent.provider ?? "unknown",
        provider: agent.provider ?? "unknown",
        model: agent.model ?? null,
        currentModeId:
            (agent.runtimeInfo?.currentModeId as string | undefined) ??
            (agent.capabilities?.currentModeId as string | undefined) ??
            null,
        status: mapDaemonWorkerStatus({
            status: agent.status,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason,
            pendingPermissions,
        }),
        rawStatus: agent.status,
        cwd: agent.cwd ?? "",
        labels,
        worktreePath: agent.worktreePath,
        branchName: agent.branchName,
        pendingPermissions,
        pendingPermissionIds,
        requiresAttention: Boolean(agent.requiresAttention),
        attentionReason: agent.attentionReason ?? null,
        runtimeInfo: agent.runtimeInfo ?? null,
        persistence: (agent.capabilities?.persistence as Record<string, unknown>) ?? null,
        unreadEventCount: 0,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
    }
}
