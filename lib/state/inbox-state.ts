import type { InboxEvent, InboxEventKind, PluginState, WorkerStatus } from "./types.js"

const DEDUPED_WORKER_EVENT_KINDS = new Set<InboxEventKind>(["worker.stalled", "agent.status", "agent.attention"])

/**
 * Sync the cached unread-event count for a worker resource.
 * @param state
 * @param resourceId
 */
function syncWorkerUnreadEventCount(state: PluginState, resourceId: string): void {
  const worker = state.workers.get(resourceId)
  if (!worker) {
    return
  }

  worker.unreadEventCount = getUnreadEventCountForResource(state, resourceId)
}

/**
 * Return the most recent unread event for a resource, if any.
 * @param state
 * @param resourceId
 * @returns The latest unread event for the resource, or null if none exist.
 */
function getLatestUnreadEventForResource(state: PluginState, resourceId: string): InboxEvent | null {
  let latest: InboxEvent | null = null
  for (const event of state.inbox.values()) {
    if (event.resourceId === resourceId && !event.read) {
      latest = event
    }
  }
  return latest
}

/**
 * Determine whether an event should be suppressed as a duplicate lifecycle update.
 * @param state
 * @param event
 * @returns True if the event is a duplicate of the latest unread event for the resource.
 */
function shouldSuppressLifecycleDuplicate(state: PluginState, event: InboxEvent): boolean {
  if (!DEDUPED_WORKER_EVENT_KINDS.has(event.kind)) {
    return false
  }

  const latest = getLatestUnreadEventForResource(state, event.resourceId)
  if (latest?.kind !== event.kind) return false
  if (event.kind === "agent.status") return latest.metadata?.status === event.metadata?.status
  if (event.kind === "agent.attention") return latest.metadata?.attentionReason === event.metadata?.attentionReason
  return true
}

/**
 * Remove an event from every session-scoped reference set.
 * @param state
 * @param eventId
 */
function removeEventReferencesFromSessions(state: PluginState, eventId: string): void {
  for (const session of state.sessions.values()) {
    session.unreadEvents.delete(eventId)
    session.pendingPermissions.delete(eventId)
  }
}

/**
 * Evict the oldest inbox event from global state.
 * @param state
 */
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

  const evicted = state.inbox.get(oldestId)
  state.inbox.delete(oldestId)
  removeEventReferencesFromSessions(state, oldestId)
  if (evicted) {
    syncWorkerUnreadEventCount(state, evicted.resourceId)
  }
}

/**
 * Count unread inbox events for a given resource ID.
 *
 * @param state - Plugin state to read from.
 * @param resourceId - Resource ID to count unread events for.
 * @returns The unread event count for the resource.
 */
export function getUnreadEventCountForResource(state: PluginState, resourceId: string): number {
  let count = 0
  for (const event of state.inbox.values()) {
    if (event.resourceId === resourceId && !event.read) {
      count += 1
    }
  }
  return count
}

/**
 * Insert an inbox event unless it is a duplicate or suppressed lifecycle update.
 *
 * @param state - Plugin state to update.
 * @param event - Inbox event to insert.
 * @param maxInboxItems - Maximum number of inbox items to retain.
 * @returns `true` when the event was inserted, otherwise `false`.
 */
export function insertInboxEvent(
  state: PluginState,
  event: InboxEvent,
  maxInboxItems = Number.POSITIVE_INFINITY,
): boolean {
  if (state.inbox.has(event.id) || shouldSuppressLifecycleDuplicate(state, event)) {
    return false
  }

  state.inbox.set(event.id, event)
  state.eventCounter++

  for (const session of state.sessions.values()) {
    if (session.createdWorkerIds.has(event.resourceId) || session.createdTerminalIds.has(event.resourceId)) {
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

  syncWorkerUnreadEventCount(state, event.resourceId)

  return true
}

/**
 * Mark a single inbox event as read and clear its session references.
 *
 * @param state - Plugin state to update.
 * @param eventId - Inbox event ID to mark as read.
 * @returns Nothing.
 */
export function markEventRead(state: PluginState, eventId: string): void {
  const event = state.inbox.get(eventId)
  if (event) {
    event.read = true
  }

  removeEventReferencesFromSessions(state, eventId)
  if (event) {
    syncWorkerUnreadEventCount(state, event.resourceId)
  }
}

/**
 * Mark every inbox event as read and clear unread session state.
 *
 * @param state - Plugin state to update.
 * @returns Nothing.
 */
export function markAllRead(state: PluginState): void {
  for (const event of state.inbox.values()) {
    event.read = true
  }
  for (const session of state.sessions.values()) {
    session.unreadEvents.clear()
    session.pendingPermissions.clear()
  }
  for (const worker of state.workers.values()) {
    worker.unreadEventCount = 0
  }
}

/**
 * Mark unread worker-stalled events for a worker as read.
 *
 * @param state - Plugin state to update.
 * @param workerId - Worker ID whose stalled events should be marked read.
 * @returns Nothing.
 */
export function markUnreadStallEventsRead(state: PluginState, workerId: string): void {
  for (const [eventId, event] of state.inbox) {
    if (event.kind === "worker.stalled" && event.resourceId === workerId && !event.read) {
      markEventRead(state, eventId)
    }
  }
}

/**
 * Mark all unread events for a resource as read.
 *
 * @param state - Plugin state to update.
 * @param resourceId - Resource ID whose events should be marked read.
 * @returns Nothing.
 */
export function markResourceEventsRead(state: PluginState, resourceId: string): void {
  for (const [eventId, event] of state.inbox) {
    if (event.resourceId === resourceId && !event.read) {
      markEventRead(state, eventId)
    }
  }
}

/**
 * Find session IDs that are bound to a resource.
 *
 * @param state - Plugin state to read from.
 * @param resourceId - Resource ID to search for.
 * @returns Session IDs that are bound to the resource.
 */
export function findSessionsForResource(state: PluginState, resourceId: string): string[] {
  const result: string[] = []
  for (const session of state.sessions.values()) {
    if (session.createdWorkerIds.has(resourceId) || session.createdTerminalIds.has(resourceId)) {
      result.push(session.opencodeSessionId)
    }
  }
  return result
}

/**
 * Find background session IDs that are bound to a resource.
 *
 * @param state - Plugin state to read from.
 * @param resourceId - Resource ID to search for.
 * @returns Session IDs that are bound to the resource as background work.
 */
export function findBackgroundSessionsForResource(state: PluginState, resourceId: string): string[] {
  const result: string[] = []
  for (const session of state.sessions.values()) {
    if (session.backgroundWorkerIds.has(resourceId)) {
      result.push(session.opencodeSessionId)
    }
  }
  return result
}

/**
 * Build metadata for a blocking inbox event.
 *
 * @param kind - Inbox event kind.
 * @param resourceId - Resource ID associated with the event.
 * @param extra - Additional metadata to include.
 * @returns Blocking metadata for the event.
 */
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
      permissionId: extra?.permissionId,
      suggestedTool: "paseo_permission_respond",
    }
  }
  return extra ?? {}
}

/**
 * Compute the blocking action for a worker-like state snapshot.
 *
 * @param w - Worker-like state snapshot to inspect.
 * @param w.status
 * @param w.pendingPermissionIds
 * @param w.requiresAttention
 * @returns The blocking action name, or `null` when none applies.
 */
export function getBlockingAction(w: {
  status: WorkerStatus
  pendingPermissionIds: string[]
  requiresAttention?: boolean
}): string | null {
  if (w.pendingPermissionIds.length > 0) {
    return "paseo_permission_respond"
  }
  return null
}
