import type { PluginState, InboxEvent, InboxEventKind } from "../state/types.js"
import { markEventRead } from "../state/state.js"

// ─── Inbox Query Operations ──────────────────────────────────────────────────

export interface InboxReadOptions {
  unreadOnly?: boolean
  kind?: InboxEventKind
  resourceId?: string
  cursor?: number
  limit?: number
  markRead?: boolean
}

export interface InboxReadResult {
  events: InboxEvent[]
  nextCursor: number | null
  hasMore: boolean
  unreadCount: number
}

export interface InboxStatusResult {
  unreadCount: number
  blockingCount: number
  byKind: Record<string, number>
  byResource: Record<string, number>
}

export function readInbox(state: PluginState, options: InboxReadOptions = {}): InboxReadResult {
  const { unreadOnly = false, kind, resourceId, cursor = 0, limit = 50, markRead = false } = options
  const events = filteredInboxEvents(state, { unreadOnly, kind, resourceId })
  const { paginated, hasMore, nextCursor } = paginateInboxEvents(events, cursor, limit)
  markPaginatedEventsRead(state, paginated, markRead)
  const unreadCount = countUnreadInboxEvents(state)

  return { events: paginated, nextCursor, hasMore, unreadCount }
}

function filteredInboxEvents(
  state: PluginState,
  options: Pick<InboxReadOptions, "unreadOnly" | "kind" | "resourceId">,
): InboxEvent[] {
  return Array.from(state.inbox.values()).sort(sortInboxNewestFirst).filter(matchesInboxReadOptions(options))
}

function sortInboxNewestFirst(a: InboxEvent, b: InboxEvent): number {
  return b.timestamp - a.timestamp
}

function matchesInboxReadOptions(options: Pick<InboxReadOptions, "unreadOnly" | "kind" | "resourceId">) {
  return (event: InboxEvent): boolean => {
    if (options.unreadOnly && event.read) return false
    if (options.kind && event.kind !== options.kind) return false
    if (options.resourceId && event.resourceId !== options.resourceId) return false
    return true
  }
}

function paginateInboxEvents(events: InboxEvent[], cursor: number, limit: number) {
  const paginated = events.slice(cursor, cursor + limit)
  const hasMore = cursor + limit < events.length
  return { paginated, hasMore, nextCursor: hasMore ? cursor + limit : null }
}

function markPaginatedEventsRead(state: PluginState, events: InboxEvent[], markRead: boolean): void {
  if (!markRead) return
  for (const event of events) {
    markEventRead(state, event.id)
  }
}

function countUnreadInboxEvents(state: PluginState): number {
  return Array.from(state.inbox.values()).filter((event) => !event.read).length
}

export function getInboxStatus(state: PluginState): InboxStatusResult {
  const events = Array.from(state.inbox.values())
  const unread = events.filter((e) => !e.read)

  const byKind: Record<string, number> = {}
  const byResource: Record<string, number> = {}

  for (const event of unread) {
    byKind[event.kind] = (byKind[event.kind] || 0) + 1
    byResource[event.resourceId] = (byResource[event.resourceId] || 0) + 1
  }

  return {
    unreadCount: unread.length,
    blockingCount: unread.filter((e) => e.blocking).length,
    byKind,
    byResource,
  }
}
