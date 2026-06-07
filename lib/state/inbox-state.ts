import type { InboxEvent, InboxEventKind, PluginState, WorkerStatus } from "./types.js"

const DEDUPED_WORKER_EVENT_KINDS = new Set<InboxEventKind>(["worker.stalled", "agent.status", "agent.attention"])

function syncWorkerUnreadEventCount(state: PluginState, resourceId: string): void {
  const worker = state.workers.get(resourceId)
  if (!worker) {
    return
  }

  worker.unreadEventCount = getUnreadEventCountForResource(state, resourceId)
}

function getLatestUnreadEventForResource(state: PluginState, resourceId: string): InboxEvent | null {
  let latest: InboxEvent | null = null
  for (const event of state.inbox.values()) {
    if (event.resourceId === resourceId && !event.read) {
      latest = event
    }
  }
  return latest
}

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

  const evicted = state.inbox.get(oldestId)
  state.inbox.delete(oldestId)
  removeEventReferencesFromSessions(state, oldestId)
  if (evicted) {
    syncWorkerUnreadEventCount(state, evicted.resourceId)
  }
}

export function getUnreadEventCountForResource(state: PluginState, resourceId: string): number {
  let count = 0
  for (const event of state.inbox.values()) {
    if (event.resourceId === resourceId && !event.read) {
      count += 1
    }
  }
  return count
}

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

export function markUnreadStallEventsRead(state: PluginState, workerId: string): void {
  for (const [eventId, event] of state.inbox) {
    if (event.kind === "worker.stalled" && event.resourceId === workerId && !event.read) {
      markEventRead(state, eventId)
    }
  }
}

export function markResourceEventsRead(state: PluginState, resourceId: string): void {
  for (const [eventId, event] of state.inbox) {
    if (event.resourceId === resourceId && !event.read) {
      markEventRead(state, eventId)
    }
  }
}

export function findSessionsForResource(state: PluginState, resourceId: string): string[] {
  const result: string[] = []
  for (const session of state.sessions.values()) {
    if (session.createdWorkerIds.has(resourceId) || session.createdTerminalIds.has(resourceId)) {
      result.push(session.opencodeSessionId)
    }
  }
  return result
}

export function findBackgroundSessionsForResource(state: PluginState, resourceId: string): string[] {
  const result: string[] = []
  for (const session of state.sessions.values()) {
    if (session.backgroundWorkerIds.has(resourceId)) {
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
      permissionId: extra?.permissionId,
      suggestedTool: "paseo_permission_respond",
    }
  }
  return extra ?? {}
}

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
