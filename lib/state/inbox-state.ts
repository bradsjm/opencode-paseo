import type { InboxEvent, InboxEventKind, PluginState, WorkerStatus } from "./types.js"

function removeEventReferencesFromSessions(state: PluginState, eventId: string): void {
    for (const session of state.sessions.values()) {
        session.unreadEvents.delete(eventId)
        session.pendingPermissions.delete(eventId)
    }
}

function evictOldestInboxEvent(state: PluginState): void {
    let oldestId: string | null = null
    let oldestTimestamp = Number.POSITIVE_INFINITY

    for (const [eventId, event] of state.inbox) {
        if (event.timestamp < oldestTimestamp) {
            oldestTimestamp = event.timestamp
            oldestId = eventId
        }
    }

    if (!oldestId) {
        return
    }

    state.inbox.delete(oldestId)
    removeEventReferencesFromSessions(state, oldestId)
}

export function insertInboxEvent(
    state: PluginState,
    event: InboxEvent,
    maxInboxItems = Number.POSITIVE_INFINITY,
): boolean {
    if (state.inbox.has(event.id)) {
        return false
    }

    state.inbox.set(event.id, event)
    state.eventCounter++

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

    while (state.inbox.size > maxInboxItems) {
        evictOldestInboxEvent(state)
    }

    return true
}

export function markEventRead(state: PluginState, eventId: string): void {
    const event = state.inbox.get(eventId)
    if (event) {
        event.read = true
    }

    removeEventReferencesFromSessions(state, eventId)
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

export function findSessionsForResource(state: PluginState, resourceId: string): string[] {
    const result: string[] = []
    for (const session of state.sessions.values()) {
        if (
            session.createdWorkerIds.has(resourceId) ||
            session.createdTerminalIds.has(resourceId)
        ) {
            result.push(session.opencodeSessionId)
        }
    }
    return result
}

export function buildBlockingMetadata(
    kind: InboxEventKind,
    resourceId: string,
    extra?: Record<string, unknown>,
): Record<string, unknown> {
    if (kind === "permission.requested") {
        return {
            ...extra,
            actionKind: "permission",
            workerId: resourceId,
            permissionId: extra?.permissionId as string | undefined,
            suggestedTool: "paseo_permission_respond",
        }
    }
    if (kind === "worker.blocked") {
        return {
            ...extra,
            actionKind: "worker-question",
            workerId: resourceId,
            suggestedTool: "paseo_worker_send",
        }
    }
    return extra ?? {}
}

export function getBlockingAction(w: {
    status: WorkerStatus
    pendingPermissionIds: string[]
}): string | null {
    if (w.status === "blocked") {
        if (w.pendingPermissionIds.length > 0) {
            return "paseo_permission_respond"
        }
        return "paseo_worker_send"
    }
    return null
}
