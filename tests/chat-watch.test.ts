import test from "node:test"
import assert from "node:assert/strict"
import { createChatWatcher } from "../lib/chat/watch.js"
import { Logger } from "../lib/logger.js"
import type { OpencodeClient } from "../lib/profile.js"
import { createPluginState, getOrCreateSession, recordCreatedWorker } from "../lib/state/state.js"
import type { PluginConfig } from "../lib/config.js"
import type { PaseoTransport, ChatMessage } from "../lib/transport/types.js"
import type { WorkerSummary } from "../lib/state/types.js"

const TEST_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    daemon: {
        host: "127.0.0.1",
        port: 6767,
        connectionTimeoutMs: 3000,
    },
    output: {
        maxInboxItems: 100,
        maxSummaryLength: 500,
    },
    notifications: {
        enabled: true,
        blockingOnly: false,
        stalledThresholdMs: 120000,
    },
    agents: {},
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
}

function buildWorker(id: string, chatRoom: string): WorkerSummary {
    return {
        id,
        title: id,
        agent: "opencode",
        status: "running",
        rawStatus: "running",
        cwd: "/tmp",
        provider: "opencode",
        model: null,
        currentModeId: null,
        labels: [],
        chatRoom,
        pendingPermissions: [],
        pendingPermissionIds: [],
        requiresAttention: false,
        attentionReason: null,
        runtimeInfo: null,
        persistence: null,
        unreadEventCount: 0,
    }
}

function attachOwnedWorker(
    state: ReturnType<typeof createPluginState>,
    sessionId: string,
    workerId: string,
    chatRoom: string,
): WorkerSummary {
    getOrCreateSession(state, sessionId, "/tmp")
    const worker = buildWorker(workerId, chatRoom)
    recordCreatedWorker(state, sessionId, worker)
    return worker
}

function addKnownWorker(
    state: ReturnType<typeof createPluginState>,
    workerId: string,
    chatRoom: string,
): WorkerSummary {
    const worker = buildWorker(workerId, chatRoom)
    state.workers.set(workerId, worker)
    return worker
}

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
    return {
        readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
        waitForChatMessages: async () => ({
            requestId: "req-wait",
            messages: [],
            timedOut: true,
            error: null,
        }),
        ...overrides,
    } as PaseoTransport
}

function createMockOpencodeClient(messages: string[]): OpencodeClient {
    return {
        session: {
            prompt: async ({ body }) => {
                const text = body.parts
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join("")
                messages.push(text)
                return { data: null }
            },
        },
    } as unknown as OpencodeClient
}

function buildMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: "msg-1",
        roomId: "room-1",
        authorAgentId: "manual",
        body: "please review",
        replyToMessageId: null,
        mentionAgentIds: [],
        createdAt: "2024-01-01T00:01:00Z",
        ...overrides,
    }
}

test("chat watcher", async (t) => {
    const logger = new Logger(false)

    await t.test("seeded cursors do not replay historical messages", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const waiting = createDeferred<{
            requestId: string
            messages: ChatMessage[]
            timedOut: boolean
            error: null
        }>()
        const client = createMockTransport({
            readChatMessages: async () => ({
                requestId: "req-read",
                messages: [buildMessage({ id: "msg-old" })],
                error: null,
            }),
            waitForChatMessages: async () => waiting.promise,
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        assert.equal(state.inbox.size, 0)
        assert.equal(state.chatRooms.get("ops")?.lastMessageId, "msg-old")
        assert.deepEqual(promptMessages, [])

        await watcher.dispose()
    })

    await t.test("exact worker-id mention creates inbox event and nudge", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const client = createMockTransport({
            readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
            waitForChatMessages: async () => ({
                requestId: "req-wait",
                messages: [buildMessage({ mentionAgentIds: ["worker-1"] })],
                timedOut: false,
                error: null,
            }),
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        const event = Array.from(state.inbox.values())[0]
        assert.ok(event)
        assert.equal(event.kind, "chat.mentioned")
        assert.equal(event.resourceId, "worker-1")
        assert.match(event.summary, /Mentioned in room "ops"/)
        assert.equal(promptMessages.length, 1)
        assert.match(promptMessages[0]!, /\[paseo:chat.mentioned\]/)

        await watcher.dispose()
    })

    await t.test("non-owned worker mentions do nothing", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        addKnownWorker(state, "worker-2", "ops")
        const client = createMockTransport({
            readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
            waitForChatMessages: async () => ({
                requestId: "req-wait",
                messages: [buildMessage({ mentionAgentIds: ["worker-2"] })],
                timedOut: false,
                error: null,
            }),
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        assert.equal(state.inbox.size, 0)
        assert.deepEqual(promptMessages, [])

        await watcher.dispose()
    })

    await t.test("title or custom-token mentions do not nudge", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const client = createMockTransport({
            readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
            waitForChatMessages: async () => ({
                requestId: "req-wait",
                messages: [
                    buildMessage({ body: "@friendly-bot", mentionAgentIds: ["friendly-bot"] }),
                ],
                timedOut: false,
                error: null,
            }),
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        assert.equal(state.inbox.size, 0)
        assert.deepEqual(promptMessages, [])

        await watcher.dispose()
    })

    await t.test("self-mentions do not nudge", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const client = createMockTransport({
            readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
            waitForChatMessages: async () => ({
                requestId: "req-wait",
                messages: [
                    buildMessage({ authorAgentId: "worker-1", mentionAgentIds: ["worker-1"] }),
                ],
                timedOut: false,
                error: null,
            }),
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        assert.equal(state.inbox.size, 0)
        assert.deepEqual(promptMessages, [])

        await watcher.dispose()
    })

    await t.test("duplicate message processing is deduped by event ID", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        let waitCalls = 0
        const client = createMockTransport({
            readChatMessages: async () => ({ requestId: "req-read", messages: [], error: null }),
            waitForChatMessages: async () => {
                waitCalls += 1
                if (waitCalls <= 2) {
                    return {
                        requestId: `req-wait-${waitCalls}`,
                        messages: [buildMessage({ mentionAgentIds: ["worker-1"] })],
                        timedOut: false,
                        error: null,
                    }
                }

                return {
                    requestId: `req-wait-${waitCalls}`,
                    messages: [],
                    timedOut: true,
                    error: null,
                }
            },
        })
        const watcher = createChatWatcher(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
            TEST_CONFIG,
        )

        watcher.observeWorker(attachOwnedWorker(state, "sess-1", "worker-1", "ops"))
        await flushAsyncWork()

        assert.equal(state.inbox.size, 1)
        assert.equal(promptMessages.length, 1)

        await watcher.dispose()
    })
})
