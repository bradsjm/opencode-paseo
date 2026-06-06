import { truncateSummary } from "../inbox/summary.js"
import type { Logger } from "../logger.js"
import { formatNudgeMessage, sendNudge, shouldNudge } from "../notifier.js"
import type { OpencodeClient } from "../profile.js"
import { insertInboxEvent } from "../state/state.js"
import type { ChatMessage, PaseoTransport } from "../transport/types.js"
import type { PluginConfig } from "../config.js"
import type { InboxEvent, PluginState, WorkerSummary } from "../state/types.js"

interface WatchedRoomState {
  room: string
  running: boolean
}

export interface ChatWatcherController {
  observeWorker(worker: Pick<WorkerSummary, "id" | "chatRoom">): void
  dispose(): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildChatMentionEventId(message: ChatMessage, workerId: string): string {
  return `chat-mention-${message.roomId}-${message.id}-${workerId}`
}

function buildChatMentionSummary(room: string, message: ChatMessage, maxSummaryLength: number): string {
  const author = message.authorAgentId || "unknown"
  const body = message.body.replace(/\s+/g, " ").trim() || "(empty message)"
  return truncateSummary(`Mentioned in room "${room}" by ${author}: ${body}`, maxSummaryLength)
}

export function createChatWatcher(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  config: PluginConfig,
): ChatWatcherController {
  const restartDelayMs = 1_000
  const watchedRooms = new Map<string, WatchedRoomState>()
  let disposed = false

  function seedRoomState(room: string): void {
    const existing = state.chatRooms.get(room)
    if (existing) {
      return
    }

    state.chatRooms.set(room, {
      name: room,
      lastMessageId: null,
      seededAt: null,
      watching: false,
    })
  }

  function noteRoomWatching(room: string, watching: boolean): void {
    seedRoomState(room)
    const entry = state.chatRooms.get(room)
    if (!entry) {
      return
    }
    entry.watching = watching
  }

  function noteRoomCursor(room: string, messageId: string | null): void {
    seedRoomState(room)
    const entry = state.chatRooms.get(room)
    if (!entry) {
      return
    }
    entry.lastMessageId = messageId
    if (entry.seededAt === null) {
      entry.seededAt = Date.now()
    }
  }

  function getMentionedKnownWorkerIds(message: ChatMessage): string[] {
    const mentioned = new Set(message.mentionAgentIds)
    if (mentioned.size === 0) {
      return []
    }

    const matched: string[] = []
    for (const workerId of mentioned) {
      const worker = state.workers.get(workerId)
      if (!worker) {
        continue
      }
      if (worker.chatRoom === undefined) {
        continue
      }
      if (message.authorAgentId === worker.id) {
        continue
      }
      matched.push(workerId)
    }
    return matched
  }

  function handleMessages(room: string, messages: ChatMessage[]): void {
    for (const message of messages) {
      noteRoomCursor(room, message.id)

      for (const workerId of getMentionedKnownWorkerIds(message)) {
        const sessionIds = Array.from(state.sessions.values())
          .filter((session) => session.createdWorkerIds.has(workerId))
          .map((session) => session.opencodeSessionId)

        if (sessionIds.length === 0) {
          continue
        }

        const event: InboxEvent = {
          id: buildChatMentionEventId(message, workerId),
          kind: "chat.mentioned",
          resourceId: workerId,
          blocking: false,
          summary: buildChatMentionSummary(room, message, config.output.maxSummaryLength),
          read: false,
          timestamp: Date.now(),
          metadata: {
            room,
            messageId: message.id,
            roomId: message.roomId,
            authorAgentId: message.authorAgentId,
          },
        }

        const inserted = insertInboxEvent(state, event, config.output.maxInboxItems)
        if (!inserted) {
          continue
        }

        if (!shouldNudge(event.kind, config.notifications)) {
          continue
        }

        sendNudge(opencodeClient, sessionIds, formatNudgeMessage(event.kind, workerId, event.summary), logger)
      }
    }
  }

  async function seedCursor(room: string): Promise<string | null> {
    const latest = await client.readChatMessages({ room, limit: 1 })
    const latestMessageId = latest.messages[0]?.id ?? null
    noteRoomCursor(room, latestMessageId)
    return latestMessageId
  }

  async function watchRoom(room: string): Promise<void> {
    const watched = watchedRooms.get(room)
    if (!canStartWatching(watched)) return

    markWatcherRunning(room, watched!)

    try {
      let afterMessageId = await initialRoomCursor(room)

      while (!disposed && watchedRooms.has(room)) {
        const result = await waitForRoomMessages(room, afterMessageId)
        if (watchStopped(room)) return
        afterMessageId = handleWatchResult(room, afterMessageId, result)
        await delay(0)
      }
    } catch (err: unknown) {
      logger.warn("Chat room watcher failed", {
        room,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      cleanupWatcher(room)
    }
  }

  function canStartWatching(watched: { running: boolean } | undefined): boolean {
    return Boolean(watched && !watched.running)
  }

  function markWatcherRunning(room: string, watched: { running: boolean }): void {
    watched.running = true
    noteRoomWatching(room, true)
  }

  async function initialRoomCursor(room: string): Promise<string | null> {
    return state.chatRooms.get(room)?.lastMessageId ?? (await seedCursor(room))
  }

  function waitForRoomMessages(room: string, afterMessageId: string | null) {
    return client.waitForChatMessages({ room, afterMessageId, timeoutMs: 30_000 })
  }

  function watchStopped(room: string): boolean {
    return disposed || !watchedRooms.has(room)
  }

  function handleWatchResult(
    room: string,
    afterMessageId: string | null,
    result: Awaited<ReturnType<typeof client.waitForChatMessages>>,
  ): string | null {
    if (result.messages.length === 0)
      return result.timedOut ? afterMessageId : (state.chatRooms.get(room)?.lastMessageId ?? afterMessageId)
    handleMessages(room, result.messages)
    return result.messages[result.messages.length - 1]?.id ?? afterMessageId
  }

  function cleanupWatcher(room: string): void {
    const latest = watchedRooms.get(room)
    if (latest) latest.running = false
    noteRoomWatching(room, false)
    if (!disposed && watchedRooms.has(room)) scheduleWatcherRestart(room)
  }

  function scheduleWatcherRestart(room: string): void {
    setTimeout(() => {
      void watchRoom(room)
    }, restartDelayMs)
  }

  return {
    observeWorker(worker) {
      const room = worker.chatRoom
      if (!room || watchedRooms.has(room) || disposed) {
        if (room) {
          seedRoomState(room)
        }
        return
      }

      seedRoomState(room)
      watchedRooms.set(room, { room, running: false })
      void watchRoom(room)
    },

    dispose() {
      disposed = true
      watchedRooms.clear()
      for (const entry of state.chatRooms.values()) {
        entry.watching = false
      }
      return Promise.resolve()
    },
  }
}
