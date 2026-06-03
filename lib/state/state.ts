import type {
    PluginState,
    SessionMapping,
    InboxEvent,
    ConnectionStatus,
    CapabilitySnapshot,
    TerminalSessionSummary,
    WorkerSummary,
} from "./types.js"

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

// ─── Inbox Operations ────────────────────────────────────────────────────────

export function insertInboxEvent(state: PluginState, event: InboxEvent): boolean {
    if (state.inbox.has(event.id)) {
        return false // dedup
    }
    state.inbox.set(event.id, event)
    state.eventCounter++

    // Also add to relevant session's unread
    for (const session of state.sessions.values()) {
        if (
            session.createdWorkerIds.has(event.resourceId) ||
            session.createdTerminalIds.has(event.resourceId)
        ) {
            session.unreadEvents.set(event.id, event)
            if (event.blocking) {
                session.pendingPermissions.set(event.id, event)
            }
            session.updatedAt = Date.now()
        }
    }

    return true
}

export function markEventRead(state: PluginState, eventId: string): void {
    const event = state.inbox.get(eventId)
    if (event) {
        event.read = true
    }

    // Remove from session unread
    for (const session of state.sessions.values()) {
        session.unreadEvents.delete(eventId)
        session.pendingPermissions.delete(eventId)
    }
}

export function markAllRead(state: PluginState): void {
    for (const event of state.inbox.values()) {
        event.read = true
    }
    for (const session of state.sessions.values()) {
        session.unreadEvents.clear()
        session.pendingPermissions.clear()
    }
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
