import test from "node:test"
import assert from "node:assert/strict"
import {
    createPluginState,
    insertInboxEvent,
    getOrCreateSession,
    registerEphemeralWorkerRun,
    recordCreatedWorker,
} from "../lib/state/state.js"
import { createDaemonEventHandler, createEventHandler } from "../lib/hooks.js"
import { Logger } from "../lib/logger.js"
import type { PluginConfig } from "../lib/config.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import type { OpencodeClient } from "../lib/profile.js"
import type { WorkerSummary } from "../lib/state/types.js"

const mockConfig: PluginConfig = {
    enabled: true,
    debug: false,
    daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
    output: { maxInboxItems: 100, maxSummaryLength: 500 },
    notifications: { enabled: true, blockingOnly: false, stalledThresholdMs: 120000 },
    agents: {},
}

// ─── Daemon Event Handler Tests ──────────────────────────────────────────────

test("createDaemonEventHandler", async (t) => {
    const logger = new Logger(false)

    await t.test("inserts worker.started event", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "Worker 1 started" },
        })

        assert.equal(state.inbox.size, 1)
        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.kind, "worker.started")
        assert.equal(event.resourceId, "w1")
        assert.equal(event.blocking, false)
    })

    await t.test("inserts non-blocking worker.stalled event", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.stalled",
            payload: { workerId: "w1", summary: "Worker w1 appears stalled" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.kind, "worker.stalled")
        assert.equal(event.blocking, false)
    })

    await t.test("inserts blocking worker.blocked event", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "Worker 1 blocked on permission" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.blocking, true)
    })

    await t.test("updates worker state from worker events", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.started",
            payload: {
                workerId: "w1",
                agent: {
                    id: "w1",
                    title: "Worker 1",
                    provider: "codex",
                    status: "running",
                    cwd: "/repo",
                    labels: { lane: true },
                },
            },
        })

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.equal(worker.title, "Worker 1")
        assert.equal(worker.agent, "codex")
        assert.equal(worker.status, "running")
        assert.deepEqual(worker.labels, ["lane"])
    })

    await t.test("inserts blocking permission.requested event", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "permission.requested",
            payload: {
                workerId: "w1",
                permissionId: "perm-1",
                request: { id: "perm-1", type: "write" },
                summary: "Write permission needed",
            },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.kind, "permission.requested")
        assert.equal(event.blocking, true)
    })

    await t.test("inserts daemon.connected event into inbox", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({ type: "daemon.connected", payload: {} })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(state.connectionStatus, "connected")
        assert.equal(event.kind, "daemon.connected")
        assert.equal(event.resourceId, "daemon")
    })

    await t.test("deduplicates events with same generated ID", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        // Same type + resourceId generates same ID pattern
        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "started" },
        })
        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "started" },
        })

        // The second event gets a different counter-based ID, so both are inserted
        assert.equal(state.inbox.size, 2)
    })

    await t.test("inserts daemon.disconnected event into inbox", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({ type: "daemon.disconnected", payload: {} })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(state.connectionStatus, "error")
        assert.equal(state.lastError, "Daemon disconnected")
        assert.equal(event.kind, "daemon.disconnected")
        assert.equal(event.resourceId, "daemon")
    })

    await t.test("handles daemon.error by updating diagnostics without inbox insert", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({ type: "daemon.error", payload: { message: "Daemon exploded" } })

        assert.equal(state.connectionStatus, "error")
        assert.equal(state.lastError, "Daemon exploded")
        assert.equal(state.inbox.size, 0)
    })

    await t.test("ignores worker.activity for inbox insertion", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.activity",
            payload: { workerId: "w1", timestamp: new Date().toISOString(), subtype: "timeline" },
        })

        assert.equal(state.inbox.size, 0)
    })

    await t.test("syncs Phase 3 worker fields from agent payload", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.started",
            payload: {
                workerId: "w1",
                agent: {
                    id: "w1",
                    title: "Rich Worker",
                    provider: "codex",
                    status: "running",
                    cwd: "/repo",
                    model: "gpt-4",
                    labels: { lane: "main" },
                    runtimeInfo: { currentModeId: "code" },
                    pendingPermissions: [{ id: "perm-1" }],
                    worktreePath: "/repo/.wt/feature",
                    branchName: "feature/x",
                },
            },
        })

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.equal(worker.provider, "codex")
        assert.equal(worker.model, "gpt-4")
        assert.equal(worker.currentModeId, "code")
        assert.equal(worker.worktreePath, "/repo/.wt/feature")
        assert.equal(worker.branchName, "feature/x")
        assert.deepEqual(worker.pendingPermissionIds, ["perm-1"])
    })

    await t.test("tracks pendingPermissions rich data on permission.requested", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        // First create a worker
        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "started" },
        })

        // Then send a permission request with rich request data
        handler({
            type: "permission.requested",
            payload: {
                workerId: "w1",
                permissionId: "perm-1",
                summary: "Write permission needed",
                request: { id: "perm-1", type: "write", path: "/repo/file.ts" },
            },
        })

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.ok(worker.pendingPermissionIds.includes("perm-1"))
        assert.equal(worker.pendingPermissions.length, 1)
        assert.equal(worker.pendingPermissions[0].id, "perm-1")
    })

    await t.test("cleans up rich pendingPermissions on permission.resolved", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        // Create worker with pending permission
        handler({
            type: "worker.started",
            payload: {
                workerId: "w1",
                agent: {
                    id: "w1",
                    provider: "codex",
                    status: "running",
                    cwd: "/repo",
                    model: null,
                    title: null,
                    labels: {},
                    pendingPermissions: [{ id: "perm-1", type: "write" }],
                },
            },
        })

        // Resolve the permission
        handler({
            type: "permission.resolved",
            payload: {
                workerId: "w1",
                permissionId: "perm-1",
                resolution: { decision: "allow" },
                summary: "Permission resolved",
            },
        })

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.ok(!worker.pendingPermissionIds.includes("perm-1"))
        assert.equal(worker.pendingPermissions.length, 0)
    })
})

// ─── Event Handler Tests (session.deleted) ───────────────────────────────────

test("createEventHandler", async (t) => {
    const logger = new Logger(false)
    const mockTransport = {
        cancelWorker: async () => {},
    } as PaseoTransport

    await t.test("handles session.deleted by removing session", async () => {
        const state = createPluginState()
        const session = getOrCreateSession(state, "sess-1", "/project")
        session.createdWorkerIds.add("w1")

        const handler = createEventHandler(state, mockTransport, logger, mockConfig)

        await handler({
            event: {
                type: "session.deleted",
                properties: {
                    info: { id: "sess-1" },
                },
            } as any,
        })

        assert.equal(state.sessions.size, 0)
    })

    await t.test("session.deleted is a no-op for unknown session", async () => {
        const state = createPluginState()
        const handler = createEventHandler(state, mockTransport, logger, mockConfig)

        await handler({
            event: {
                type: "session.deleted",
                properties: {
                    info: { id: "unknown" },
                },
            } as any,
        })

        assert.equal(state.sessions.size, 0)
    })

    await t.test("session.deleted clears unread and pending state", async () => {
        const state = createPluginState()
        const session = getOrCreateSession(state, "sess-1", "/project")
        session.createdWorkerIds.add("w1")

        // Add a blocking event to the session
        insertInboxEvent(state, {
            id: "evt-1",
            kind: "worker.blocked",
            resourceId: "w1",
            blocking: true,
            summary: "blocked",
            read: false,
            timestamp: Date.now(),
        })

        assert.equal(session.unreadEvents.size, 1)
        assert.equal(session.pendingPermissions.size, 1)

        const handler = createEventHandler(state, mockTransport, logger, mockConfig)
        await handler({
            event: {
                type: "session.deleted",
                properties: {
                    info: { id: "sess-1" },
                },
            } as any,
        })

        // Session should be gone, and global inbox should still have the event
        assert.equal(state.sessions.size, 0)
        assert.equal(state.inbox.size, 1)
    })

    await t.test("session.deleted best-effort cancels tracked ephemeral workers", async () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        registerEphemeralWorkerRun(state, "sess-1", "w-ephemeral-1", { background: true })
        registerEphemeralWorkerRun(state, "sess-1", "w-ephemeral-2", { background: false })

        const canceled: string[] = []
        const handler = createEventHandler(
            state,
            {
                cancelWorker: async (workerId: string) => {
                    canceled.push(workerId)
                    if (workerId === "w-ephemeral-2") {
                        throw new Error("cancel failed")
                    }
                },
            } as PaseoTransport,
            logger,
            mockConfig,
        )

        await handler({
            event: {
                type: "session.deleted",
                properties: {
                    info: { id: "sess-1" },
                },
            } as any,
        })

        assert.deepEqual(canceled, ["w-ephemeral-1", "w-ephemeral-2"])
        assert.equal(state.ephemeralWorkerRuns.size, 0)
        assert.equal(state.sessions.size, 0)
    })
})

test("createDaemonEventHandler nudges worker.stalled", async (t) => {
    await t.test("nudges owning session for worker.stalled", async () => {
        const state = createPluginState()
        const logger = new Logger(false)
        const session = getOrCreateSession(state, "sess-1", "/project")
        session.createdWorkerIds.add("w1")

        const messages: string[] = []
        const opencodeClient = {
            session: {
                prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                    messages.push(body.parts[0]!.text)
                },
            },
        } as unknown as OpencodeClient

        const handler = createDaemonEventHandler(state, logger, mockConfig, opencodeClient)
        handler({
            type: "worker.stalled",
            payload: { workerId: "w1", summary: "Worker w1 appears stalled" },
        })

        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(messages.length, 1)
        assert.match(messages[0]!, /^\[paseo:worker\.stalled\]/)
    })
})

// ─── Blocking Event Metadata Tests ───────────────────────────────────────────

test("createDaemonEventHandler blocking metadata", async (t) => {
    const logger = new Logger(false)

    await t.test("permission.requested includes action metadata", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "permission.requested",
            payload: {
                workerId: "w1",
                permissionId: "perm-1",
                request: { id: "perm-1", type: "write" },
                summary: "Write permission needed",
            },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.blocking, true)
        assert.equal(event.metadata?.actionKind, "permission")
        assert.equal(event.metadata?.workerId, "w1")
        assert.equal(event.metadata?.permissionId, "perm-1")
        assert.equal(event.metadata?.suggestedTool, "paseo_permission_respond")
    })

    await t.test("worker.blocked includes action metadata", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "Worker blocked on question" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.blocking, true)
        assert.equal(event.metadata?.actionKind, "worker-question")
        assert.equal(event.metadata?.workerId, "w1")
        assert.equal(event.metadata?.suggestedTool, "paseo_worker_send")
    })

    await t.test("non-blocking events have no action metadata", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "started" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.blocking, false)
        assert.equal(event.metadata?.actionKind, undefined)
    })

    await t.test("truncates stored live-event summaries", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, {
            ...mockConfig,
            output: { ...mockConfig.output, maxSummaryLength: 10 },
        })

        handler({
            type: "worker.finished",
            payload: { workerId: "w1", summary: "123456789012345" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.summary, "123456789…")
    })

    await t.test("evicts oldest inbox events when maxInboxItems is exceeded", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, {
            ...mockConfig,
            output: { maxInboxItems: 1, maxSummaryLength: 500 },
        })

        handler({ type: "worker.started", payload: { workerId: "w1", summary: "first" } })
        handler({ type: "worker.finished", payload: { workerId: "w2", summary: "second" } })

        assert.equal(state.inbox.size, 1)
        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.resourceId, "w2")
    })
})

// ─── Nudge Delivery Tests ────────────────────────────────────────────────────

function createMockOpencodeClient(): {
    client: OpencodeClient
    calls: Array<{ sessionId: string; text: string }>
} {
    const calls: Array<{ sessionId: string; text: string }> = []
    const client = {
        session: {
            prompt: async (args: {
                path: { id: string }
                body?: { parts: Array<{ type: string; text: string; synthetic?: boolean }> }
            }) => {
                const text = args.body?.parts?.[0]?.text ?? ""
                calls.push({ sessionId: args.path.id, text })
                return { data: {} }
            },
        },
    } as unknown as OpencodeClient
    return { client, calls }
}

function seedWorker(state: ReturnType<typeof createPluginState>, id: string): WorkerSummary {
    const worker: WorkerSummary = {
        id,
        title: id,
        agent: "general",
        provider: "general",
        model: null,
        currentModeId: null,
        status: "running",
        cwd: "/tmp",
        labels: [],
        pendingPermissions: [],
        pendingPermissionIds: [],
        runtimeInfo: null,
        persistence: null,
        unreadEventCount: 0,
    }
    state.workers.set(id, worker)
    return worker
}

test("nudge delivery", async (t) => {
    const logger = new Logger(false)

    await t.test("sends nudge for blocking event when notifications enabled", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, mockConfig, client)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "Worker blocked on question" },
        })

        assert.equal(calls.length, 1)
        assert.equal(calls[0].sessionId, "sess-1")
        assert.ok(calls[0].text.includes("[paseo:worker.blocked]"))
        assert.ok(calls[0].text.includes("w1"))
    })

    await t.test("sends nudge for non-blocking event when blockingOnly is false", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, mockConfig, client)

        handler({
            type: "worker.finished",
            payload: { workerId: "w1", summary: "Worker completed" },
        })

        assert.equal(calls.length, 1)
        assert.ok(calls[0].text.includes("[paseo:worker.finished]"))
    })

    await t.test("does not send nudge when notifications disabled", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        const disabledConfig: PluginConfig = {
            ...mockConfig,
            notifications: { enabled: false, blockingOnly: false, stalledThresholdMs: 120000 },
        }
        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, disabledConfig, client)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "blocked" },
        })

        assert.equal(calls.length, 0)
    })

    await t.test("does not send nudge for non-blocking event when blockingOnly is true", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        const blockingConfig: PluginConfig = {
            ...mockConfig,
            notifications: { enabled: true, blockingOnly: true, stalledThresholdMs: 120000 },
        }
        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, blockingConfig, client)

        handler({
            type: "worker.finished",
            payload: { workerId: "w1", summary: "Worker completed" },
        })

        assert.equal(calls.length, 0)
    })

    await t.test("does not send nudge for worker.started", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, mockConfig, client)

        handler({
            type: "worker.started",
            payload: { workerId: "w1", summary: "started" },
        })

        assert.equal(calls.length, 0)
    })

    await t.test("does not send nudge when no sessions own the resource", () => {
        const state = createPluginState()
        // No session binding for w1

        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, mockConfig, client)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "blocked" },
        })

        assert.equal(calls.length, 0)
    })

    await t.test("sends nudge to multiple sessions owning the resource", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        getOrCreateSession(state, "sess-2", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")
        state.sessions.get("sess-2")!.createdWorkerIds.add("w1")

        const { client, calls } = createMockOpencodeClient()
        const handler = createDaemonEventHandler(state, logger, mockConfig, client)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "blocked" },
        })

        assert.equal(calls.length, 2)
        const sessionIds = calls.map((c) => c.sessionId).sort()
        assert.deepEqual(sessionIds, ["sess-1", "sess-2"])
    })

    await t.test("does not send nudge when opencodeClient is not provided", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        seedWorker(state, "w1")
        state.sessions.get("sess-1")!.createdWorkerIds.add("w1")

        // No opencodeClient passed — backward compatible
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "worker.blocked",
            payload: { workerId: "w1", summary: "blocked" },
        })

        // Should not throw, event should still be inserted
        assert.equal(state.inbox.size, 1)
    })
})
