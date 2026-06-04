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
    const {
        unreadOnly = false,
        kind,
        resourceId,
        cursor = 0,
        limit = 50,
        markRead = false,
    } = options

    // Collect and filter events
    let events = Array.from(state.inbox.values())

    // Sort by timestamp descending (newest first)
    events.sort((a, b) => b.timestamp - a.timestamp)

    if (unreadOnly) {
        events = events.filter((e) => !e.read)
    }
    if (kind) {
        events = events.filter((e) => e.kind === kind)
    }
    if (resourceId) {
        events = events.filter((e) => e.resourceId === resourceId)
    }

    // Apply cursor (skip events before cursor position)
    const paginated = events.slice(cursor, cursor + limit)
    const hasMore = cursor + limit < events.length
    const nextCursor = hasMore ? cursor + limit : null

    // Mark read if requested
    if (markRead) {
        for (const event of paginated) {
            markEventRead(state, event.id)
        }
    }

    // Count total unread
    const unreadCount = Array.from(state.inbox.values()).filter((e) => !e.read).length

    return { events: paginated, nextCursor, hasMore, unreadCount }
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
