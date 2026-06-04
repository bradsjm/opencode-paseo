import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState, insertInboxEvent, markEventRead } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import type { WorkerSummary } from "../lib/state/types.js"
import { Logger } from "../lib/logger.js"
import {
    createWorkerArchiveTool,
    createWorkerCancelTool,
    createWorkerCreateTool,
    createWorkerInspectTool,
    createWorkerLaunchStatusTool,
    createWorkerListTool,
    createWorkerUpdateTool,
    createWorkerWaitTool,
} from "../lib/tools/worker.js"
import type { OpencodeClient } from "../lib/profile.js"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { DaemonEvent, DaemonEventCallback } from "../lib/transport/types.js"
import type { PluginConfig } from "../lib/config.js"
import { createWorkerLaunchQueueController } from "../lib/worker-launch/queue.js"

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
    return {
        isConnected: () => true,
        connect: async () => {},
        close: async () => {},
        getServerInfo: () => null,
        fetchAgents: async () => [],
        listTerminals: async () => [],
        getStatus: async () => ({}),
        getProvidersSnapshot: async () => [],
        onEvent: () => () => {},
        createTerminal: async () => ({ id: "t", name: "t" }),
        captureTerminal: async () => ({
            terminalId: "t",
            content: "",
            lineCount: 0,
            truncated: false,
        }),
        sendTerminalInput: () => {},
        killTerminal: async () => ({ id: "t", exitCode: null }),
        respondToPermission: async (opts) => ({
            workerId: opts.workerId,
            permissionId: opts.permissionId,
            behavior: opts.behavior,
        }),
        createWorker: async () => ({
            id: "w",
            provider: "test",
            cwd: "/tmp",
            model: null,
            status: "running" as const,
            title: null,
        }),
        sendWorkerMessage: async () => {},
        waitForWorker: async () => ({
            status: "idle" as const,
            workerId: "w",
            error: null,
            lastMessage: null,
            finalSnapshot: null,
        }),
        cancelWorker: async () => {},
        killWorker: async () => {},
        archiveWorker: async (workerId) => ({
            workerId,
            archivedAt: new Date().toISOString(),
        }),
        fetchWorker: async () => null,
        updateWorker: async (opts) => ({
            workerId: opts.workerId,
            updated: true,
            metadataUpdated: opts.name !== undefined || opts.labels !== undefined,
            settingsUpdated: opts.settings !== undefined,
            errors: [],
        }),
        fetchWorkerActivity: async (opts) => ({
            workerId: opts.workerId,
            activity: null,
        }),
        listWorktrees: async () => ({ requestId: "req", worktrees: [], error: null }),
        createWorktree: async () => ({ requestId: "req", workspace: null, error: null }),
        archiveWorktree: async () => ({ requestId: "req", success: true, error: null }),
        scheduleList: async () => ({ requestId: "req", schedules: [], error: null }),
        scheduleInspect: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleCreate: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleUpdate: async () => ({ requestId: "req", schedule: null, error: null }),
        schedulePause: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleResume: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleDelete: async () => ({ requestId: "req", scheduleId: "sched", error: null }),
        scheduleRunOnce: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleLogs: async () => ({ requestId: "req", runs: [], error: null }),
        ...overrides,
    }
}

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

function seedWorker(state: ReturnType<typeof createPluginState>, id: string): WorkerSummary {
    const worker: WorkerSummary = {
        id,
        title: `Worker ${id}`,
        agent: id,
        status: "running",
        cwd: "/tmp",
        provider: "test",
        model: null,
        currentModeId: null,
        labels: [],
        worktreePath: undefined,
        branchName: undefined,
        pendingPermissions: [],
        pendingPermissionIds: [],
        rawStatus: "running",
        requiresAttention: false,
        attentionReason: null,
        runtimeInfo: null,
        persistence: null,
        unreadEventCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
    state.workers.set(id, worker)
    // Bind to a session
    state.sessions.set("sess-1", {
        opencodeSessionId: "sess-1",
        projectRoot: "/tmp",
        createdTerminalIds: new Set(),
        createdWorkerIds: new Set([id]),
        unreadEvents: new Map(),
        pendingPermissions: new Map(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    })
    return worker
}

function mockContext(): ToolContext {
    return {
        sessionID: "sess-1",
        messageID: "msg-1",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
    }
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
}

// ─── Wait Tool Tests ─────────────────────────────────────────────────────────

test("paseo_worker_wait", async (t) => {
    const logger = new Logger(false)

    await t.test("single-item workerIds with all returns completed result", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            waitForWorker: async (workerId) => ({
                status: "idle",
                workerId,
                error: null,
                lastMessage: "done",
                finalSnapshot: null,
            }),
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute({ workerIds: ["w1"] }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.waitFor, "all")
        assert.deepEqual(output.workerIds, ["w1"])
        assert.equal(output.timedOut, false)
        assert.deepEqual(output.pendingWorkerIds, [])
        assert.equal(output.results.length, 1)
        assert.equal(output.results[0].workerId, "w1")
    })

    await t.test("any returns when first target finishes", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        seedWorker(state, "w2")
        let w2Calls = 0
        const client = createMockTransport({
            waitForWorker: async (workerId) => {
                if (workerId === "w1") {
                    return {
                        status: "idle",
                        workerId,
                        error: null,
                        lastMessage: "done",
                        finalSnapshot: null,
                    }
                }

                w2Calls += 1
                return {
                    status: "timeout",
                    workerId,
                    error: null,
                    lastMessage: null,
                    finalSnapshot: null,
                }
            },
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute(
            { workerIds: ["w1", "w2"], waitFor: "any", timeout: 1000 },
            mockContext(),
        )
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.timedOut, false)
        assert.deepEqual(output.pendingWorkerIds, ["w2"])
        assert.deepEqual(
            output.results.map((entry: { workerId: string }) => entry.workerId),
            ["w1"],
        )
        assert.equal(w2Calls, 1)
    })

    await t.test("all waits for all targets", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        seedWorker(state, "w2")
        const seen = new Map<string, number>()
        const client = createMockTransport({
            waitForWorker: async (workerId) => {
                const next = (seen.get(workerId) ?? 0) + 1
                seen.set(workerId, next)
                if (workerId === "w1") {
                    return {
                        status: "idle",
                        workerId,
                        error: null,
                        lastMessage: "done-1",
                        finalSnapshot: null,
                    }
                }

                return next >= 2
                    ? {
                          status: "idle",
                          workerId,
                          error: null,
                          lastMessage: "done-2",
                          finalSnapshot: null,
                      }
                    : {
                          status: "timeout",
                          workerId,
                          error: null,
                          lastMessage: null,
                          finalSnapshot: null,
                      }
            },
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute(
            { workerIds: ["w1", "w2"], waitFor: "all", timeout: 1000 },
            mockContext(),
        )
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.timedOut, false)
        assert.deepEqual(output.pendingWorkerIds, [])
        assert.deepEqual(
            output.results.map((entry: { workerId: string }) => entry.workerId),
            ["w1", "w2"],
        )
        assert.equal(seen.get("w2"), 2)
    })

    await t.test("global timeout leaves pending ids", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        seedWorker(state, "w2")
        const client = createMockTransport({
            waitForWorker: async (workerId) => ({
                status: "timeout",
                workerId,
                error: null,
                lastMessage: null,
                finalSnapshot: null,
            }),
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute(
            { workerIds: ["w1", "w2"], waitFor: "all", timeout: 1 },
            mockContext(),
        )
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.timedOut, true)
        assert.deepEqual(output.pendingWorkerIds, ["w1", "w2"])
        assert.deepEqual(output.results, [])
    })

    await t.test("fails immediately on unknown worker", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport()

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        await assert.rejects(
            () => toolDef.execute({ workerIds: ["w1", "missing"] }, mockContext()),
            /not found in local state/,
        )
    })

    await t.test("early exit on owned worker nudge for waited worker", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let listener: DaemonEventCallback | undefined
        const client = createMockTransport({
            onEvent: (callback) => {
                listener = callback
                return () => {
                    listener = undefined
                }
            },
            waitForWorker: async (workerId) => {
                listener?.({
                    type: "worker.blocked",
                    payload: { workerId, summary: "needs permission" },
                } satisfies DaemonEvent)
                return {
                    status: "timeout",
                    workerId,
                    error: null,
                    lastMessage: null,
                    finalSnapshot: null,
                }
            },
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.interruptedByNudge, true)
        assert.equal(output.nudgeEvent.kind, "worker.blocked")
        assert.equal(output.nudgeEvent.workerId, "w1")
        assert.equal(output.timedOut, false)
    })

    await t.test("early exit on unread worker.stalled event", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        insertInboxEvent(state, {
            id: "evt-stalled",
            kind: "worker.stalled",
            resourceId: "w1",
            blocking: false,
            summary: "Worker appears stalled",
            read: false,
            timestamp: Date.now(),
        })

        const client = createMockTransport()
        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.interruptedByNudge, true)
        assert.equal(output.nudgeEvent.kind, "worker.stalled")
        assert.equal(output.nudgeEvent.workerId, "w1")
    })

    await t.test("read worker.stalled event no longer interrupts wait", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        insertInboxEvent(state, {
            id: "evt-stalled-read",
            kind: "worker.stalled",
            resourceId: "w1",
            blocking: false,
            summary: "Recovered stall",
            read: false,
            timestamp: Date.now(),
        })
        markEventRead(state, "evt-stalled-read")

        const client = createMockTransport({
            waitForWorker: async (workerId) => ({
                status: "idle",
                workerId,
                error: null,
                lastMessage: "done",
                finalSnapshot: null,
            }),
        })
        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.interruptedByNudge, false)
        assert.equal(output.results[0].workerId, "w1")
    })

    await t.test("early exit on owned worker nudge for different owned worker", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        seedWorker(state, "w2")
        let listener: DaemonEventCallback | undefined
        const client = createMockTransport({
            onEvent: (callback) => {
                listener = callback
                return () => {
                    listener = undefined
                }
            },
            waitForWorker: async (workerId) => {
                if (workerId === "w1") {
                    listener?.({
                        type: "permission.requested",
                        payload: {
                            workerId: "w2",
                            permissionId: "perm-1",
                            request: {},
                            summary: "approval needed",
                        },
                    } satisfies DaemonEvent)
                }
                return {
                    status: "timeout",
                    workerId,
                    error: null,
                    lastMessage: null,
                    finalSnapshot: null,
                }
            },
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(output.interruptedByNudge, true)
        assert.equal(output.nudgeEvent.kind, "permission.requested")
        assert.equal(output.nudgeEvent.workerId, "w2")
    })

    await t.test("temporary listener is removed on timeout exit", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let activeListeners = 0
        const client = createMockTransport({
            onEvent: () => {
                activeListeners += 1
                return () => {
                    activeListeners -= 1
                }
            },
            waitForWorker: async (workerId) => ({
                status: "timeout",
                workerId,
                error: null,
                lastMessage: null,
                finalSnapshot: null,
            }),
        })

        const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
        await toolDef.execute({ workerIds: ["w1"], timeout: 1 }, mockContext())

        assert.equal(activeListeners, 0)
    })
})

// ─── Cancel Tool Tests ───────────────────────────────────────────────────────

test("paseo_worker_cancel", async (t) => {
    const logger = new Logger(false)

    await t.test("default cancel sets status to canceled and keeps worker in state", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let cancelCalled = false
        const client = createMockTransport({
            cancelWorker: async () => {
                cancelCalled = true
            },
        })

        const toolDef = createWorkerCancelTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())

        assert.ok(cancelCalled)
        assert.ok(state.workers.has("w1"))
        assert.equal(state.workers.get("w1")!.status, "canceled")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.action, "canceled")
    })

    await t.test("forceKill removes worker from state and unbinds sessions", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let killCalled = false
        const client = createMockTransport({
            killWorker: async () => {
                killCalled = true
            },
        })

        const toolDef = createWorkerCancelTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1", forceKill: true }, mockContext())

        assert.ok(killCalled)
        assert.ok(!state.workers.has("w1"))
        // Session binding should be cleared
        const session = state.sessions.get("sess-1")
        assert.ok(session)
        assert.equal(session.createdWorkerIds.has("w1"), false)
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.action, "killed")
    })

    await t.test("forceKill false behaves like normal cancel", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let cancelCalled = false
        let killCalled = false
        const client = createMockTransport({
            cancelWorker: async () => {
                cancelCalled = true
            },
            killWorker: async () => {
                killCalled = true
            },
        })

        const toolDef = createWorkerCancelTool(state, client, logger)
        await toolDef.execute({ workerId: "w1", forceKill: false }, mockContext())

        assert.ok(cancelCalled)
        assert.ok(!killCalled)
        assert.ok(state.workers.has("w1"))
    })

    await t.test("throws when worker not in state", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const toolDef = createWorkerCancelTool(state, client, logger)
        await assert.rejects(
            () => toolDef.execute({ workerId: "nonexistent" }, mockContext()),
            /not found in local state/,
        )
    })

    await t.test("description warns that forceKill should capture output first", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const toolDef = createWorkerCancelTool(state, client, logger)

        assert.match(toolDef.description, /Before using forceKill=true/i)
        assert.match(toolDef.description, /capture any important output or status first/i)
        assert.match(toolDef.description, /destructive and irreversible/i)
        const forceKillArg = toolDef.args.forceKill as { description?: string }
        assert.match(forceKillArg.description ?? "", /capture any needed output or status first/i)
    })
})

// ─── Archive Tool Tests ──────────────────────────────────────────────────────

test("paseo_worker_archive", async (t) => {
    const logger = new Logger(false)

    await t.test("successful archive removes local worker state and actionable refs", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        insertInboxEvent(state, {
            id: "evt-1",
            kind: "worker.blocked",
            resourceId: "w1",
            blocking: true,
            summary: "needs approval",
            read: false,
            timestamp: Date.now(),
        })

        const toolDef = createWorkerArchiveTool(state, createMockTransport(), logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(state.workers.has("w1"), false)
        assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w1"), false)
        assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-1"), false)
        assert.equal(state.sessions.get("sess-1")?.pendingPermissions.has("evt-1"), false)
        assert.equal(state.inbox.has("evt-1"), true)
        assert.equal(output.workerId, "w1")
        assert.equal(output.alreadyRemovedUpstream, false)
        assert.equal(typeof output.archivedAt, "string")
    })

    await t.test("upstream not found still cleans local state", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        insertInboxEvent(state, {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "started",
            read: false,
            timestamp: Date.now(),
        })
        const client = createMockTransport({
            archiveWorker: async () => {
                throw new Error("Agent not found")
            },
        })

        const toolDef = createWorkerArchiveTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(state.workers.has("w1"), false)
        assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w1"), false)
        assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-1"), false)
        assert.equal(state.inbox.has("evt-1"), true)
        assert.equal(output.workerId, "w1")
        assert.equal(output.archivedAt, null)
        assert.equal(output.alreadyRemovedUpstream, true)
    })

    await t.test("non-not-found archive errors still fail and keep local state", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            archiveWorker: async () => {
                throw new Error("daemon unavailable")
            },
        })

        const toolDef = createWorkerArchiveTool(state, client, logger)
        await assert.rejects(
            () => toolDef.execute({ workerId: "w1" }, mockContext()),
            /daemon unavailable/,
        )
        assert.equal(state.workers.has("w1"), true)
        assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w1"), true)
    })
})

// ─── List Tool Tests ─────────────────────────────────────────────────────────

test("paseo_worker_list", async (t) => {
    const logger = new Logger(false)

    await t.test("successful refresh prunes workers missing from daemon results", async () => {
        const state = createPluginState()
        const stale = seedWorker(state, "w-stale")
        stale.status = "finished"
        seedWorker(state, "w-live")
        state.sessions.get("sess-1")?.createdWorkerIds.add("w-stale")
        insertInboxEvent(state, {
            id: "evt-stale",
            kind: "worker.blocked",
            resourceId: "w-stale",
            blocking: true,
            summary: "stale worker event",
            read: false,
            timestamp: Date.now(),
        })

        const client = createMockTransport({
            fetchAgents: async () => [
                {
                    id: "w-live",
                    provider: "test",
                    cwd: "/tmp",
                    model: null,
                    status: "running",
                    title: "Live Worker",
                    labels: {},
                    pendingPermissions: [],
                },
                {
                    id: "w-new",
                    provider: "test",
                    cwd: "/tmp",
                    model: null,
                    status: "idle",
                    title: "New Worker",
                    labels: {},
                    pendingPermissions: [],
                },
            ],
        })

        const toolDef = createWorkerListTool(state, client, logger)
        const result = await toolDef.execute({}, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(state.workers.has("w-stale"), false)
        assert.equal(state.workers.has("w-live"), true)
        assert.equal(state.workers.has("w-new"), true)
        assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w-stale"), false)
        assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-stale"), false)
        assert.equal(state.sessions.get("sess-1")?.pendingPermissions.has("evt-stale"), false)
        assert.equal(state.inbox.has("evt-stale"), true)
        assert.equal(output.count, 2)
        assert.deepEqual(output.workers.map((worker: { id: string }) => worker.id).sort(), [
            "w-live",
            "w-new",
        ])
    })

    await t.test("failed refresh does not prune local workers", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            fetchAgents: async () => {
                throw new Error("fetch failed")
            },
        })

        const toolDef = createWorkerListTool(state, client, logger)
        const result = await toolDef.execute({}, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.equal(state.workers.has("w1"), true)
        assert.equal(output.count, 1)
        assert.equal(output.workers[0].id, "w1")
    })
})

// ─── Update Tool Tests ───────────────────────────────────────────────────────

test("paseo_worker_update", async (t) => {
    const logger = new Logger(false)

    await t.test("passes name and labels through to transport", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let receivedOptions: any = null
        const client = createMockTransport({
            updateWorker: async (opts) => {
                receivedOptions = opts
                return {
                    workerId: opts.workerId,
                    updated: true,
                    metadataUpdated: true,
                    settingsUpdated: false,
                    errors: [],
                }
            },
        })

        const toolDef = createWorkerUpdateTool(state, client, logger)
        const result = await toolDef.execute(
            { workerId: "w1", name: "New Name", labels: { env: "prod" } },
            mockContext(),
        )

        assert.equal(receivedOptions.workerId, "w1")
        assert.equal(receivedOptions.name, "New Name")
        assert.deepEqual(receivedOptions.labels, { env: "prod" })
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.updated, true)
        assert.equal(output.metadataUpdated, true)
    })

    await t.test("passes settings through to transport", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let receivedOptions: any = null
        const client = createMockTransport({
            updateWorker: async (opts) => {
                receivedOptions = opts
                return {
                    workerId: opts.workerId,
                    updated: true,
                    metadataUpdated: false,
                    settingsUpdated: true,
                    errors: [],
                }
            },
        })

        const toolDef = createWorkerUpdateTool(state, client, logger)
        await toolDef.execute(
            {
                workerId: "w1",
                settings: {
                    modeId: "code",
                    model: "gpt-4",
                    thinkingOptionId: null,
                    features: { streaming: true },
                },
            },
            mockContext(),
        )

        assert.deepEqual(receivedOptions.settings, {
            modeId: "code",
            model: "gpt-4",
            thinkingOptionId: null,
            features: { streaming: true },
        })
    })

    // ─── Worker Create Tool Tests ──────────────────────────────────────────────

    function mockOpencodeClient(
        agents: Array<Record<string, unknown>> = [
            {
                name: "build",
                description: "Build agent",
                mode: "primary",
                model: { providerID: "openai", modelID: "gpt-5.4" },
            },
            {
                name: "review",
                description: "Code reviewer",
                mode: "subagent",
                model: { providerID: "anthropic", modelID: "claude-3" },
            },
        ],
    ): OpencodeClient {
        return {
            app: {
                agents: async () => ({ data: agents }),
            },
            session: {
                prompt: async () => ({ data: null }),
            },
        } as unknown as OpencodeClient
    }

    test("paseo_worker_create", async (t) => {
        const logger = new Logger(false)

        await t.test(
            "returns queued receipt and defaults to build profile when no profile specified",
            async () => {
                const state = createPluginState()
                let receivedOptions: any = null
                const client = createMockTransport({
                    createWorker: async (opts) => {
                        receivedOptions = opts
                        return {
                            id: "w1",
                            provider: "opencode",
                            cwd: "/tmp",
                            model: "openai/gpt-5.4",
                            status: "running" as const,
                            title: null,
                        }
                    },
                })
                const opencode = mockOpencodeClient()
                const workerLaunchQueue = createWorkerLaunchQueueController(
                    state,
                    client,
                    opencode,
                    logger,
                )

                const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
                const result = await toolDef.execute({}, mockContext())

                assert.equal(receivedOptions.profile, "build")
                assert.equal(receivedOptions.modeId, "build")
                assert.equal(receivedOptions.provider, "opencode")
                assert.equal(receivedOptions.model, "openai/gpt-5.4")
                const output = JSON.parse((result as { output: string }).output)
                assert.equal(output.profile, "build")
                assert.equal(output.status, "queued")
                assert.equal(output.position, 1)
                assert.equal(typeof output.launchId, "string")
                assert.equal("id" in output, false)
            },
        )

        await t.test("uses specified profile", async () => {
            const state = createPluginState()
            let receivedOptions: any = null
            const client = createMockTransport({
                createWorker: async (opts) => {
                    receivedOptions = opts
                    return {
                        id: "w2",
                        provider: "opencode",
                        cwd: "/tmp",
                        model: "anthropic/claude-3",
                        status: "running" as const,
                        title: null,
                    }
                },
            })
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            await toolDef.execute({ profile: "review" }, mockContext())

            assert.equal(receivedOptions.profile, "review")
            assert.equal(receivedOptions.modeId, "review")
            assert.equal(receivedOptions.provider, "opencode")
            assert.equal(receivedOptions.model, "anthropic/claude-3")
        })

        await t.test("normalizes empty/whitespace profile to build", async () => {
            const state = createPluginState()
            let receivedOptions: any = null
            const client = createMockTransport({
                createWorker: async (opts) => {
                    receivedOptions = opts
                    return {
                        id: "w3",
                        provider: "openai",
                        cwd: "/tmp",
                        model: null,
                        status: "running" as const,
                        title: null,
                    }
                },
            })
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            await toolDef.execute({ profile: "   " }, mockContext())

            assert.equal(receivedOptions.profile, "build")
            assert.equal(receivedOptions.modeId, "build")
            assert.equal(receivedOptions.provider, "opencode")
            assert.equal(receivedOptions.model, "openai/gpt-5.4")
        })

        await t.test(
            "uses opencode provider and omits model for partial profile model metadata",
            async () => {
                const state = createPluginState()
                let receivedOptions: any = null
                const client = createMockTransport({
                    createWorker: async (opts) => {
                        receivedOptions = opts
                        return {
                            id: "w-partial",
                            provider: "opencode",
                            cwd: "/tmp",
                            model: null,
                            status: "running" as const,
                            title: null,
                        }
                    },
                })
                const opencode = mockOpencodeClient([
                    {
                        name: "partial",
                        description: "Partial agent",
                        mode: "primary",
                        model: { providerID: "openai", modelID: null },
                    },
                ])
                const workerLaunchQueue = createWorkerLaunchQueueController(
                    state,
                    client,
                    opencode,
                    logger,
                )

                const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
                await toolDef.execute({ profile: "partial" }, mockContext())

                assert.equal(receivedOptions.profile, "partial")
                assert.equal(receivedOptions.modeId, "partial")
                assert.equal(receivedOptions.provider, "opencode")
                assert.equal(receivedOptions.model, undefined)
            },
        )

        await t.test("throws clear error for unknown profile", async () => {
            const state = createPluginState()
            const client = createMockTransport()
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            await assert.rejects(
                () => toolDef.execute({ profile: "nonexistent" }, mockContext()),
                /Profile "nonexistent" not found\. Available profiles: build, review/,
            )
        })

        await t.test("passes initialPrompt and labels through", async () => {
            const state = createPluginState()
            let receivedOptions: any = null
            const client = createMockTransport({
                createWorker: async (opts) => {
                    receivedOptions = opts
                    return {
                        id: "w4",
                        provider: "opencode",
                        cwd: "/tmp",
                        model: null,
                        status: "running" as const,
                        title: null,
                    }
                },
            })
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            const result = await toolDef.execute(
                {
                    initialPrompt: "Fix the bug",
                    labels: {
                        priority: "high",
                        "opencodePaseo.launchId": "user-launch",
                        "opencodePaseo.sessionId": "user-session",
                        "opencodePaseo.worktreeName": "user-worktree",
                    },
                    worktreeName: "repo-worktree",
                },
                mockContext(),
            )

            const output = JSON.parse((result as { output: string }).output)
            assert.equal(receivedOptions.initialPrompt, "Fix the bug")
            assert.deepEqual(receivedOptions.labels, {
                priority: "high",
                "opencodePaseo.launchId": output.launchId,
                "opencodePaseo.sessionId": "sess-1",
                "opencodePaseo.worktreeName": "repo-worktree",
            })
        })

        await t.test("reports queued position behind an active launch", async () => {
            const state = createPluginState()
            const firstCreate = createDeferred<{
                id: string
                provider: string
                cwd: string
                model: string | null
                status: "running"
                title: null
            }>()
            let createCount = 0
            const client = createMockTransport({
                createWorker: async () => {
                    createCount += 1
                    if (createCount === 1) {
                        return firstCreate.promise
                    }

                    return {
                        id: "w6",
                        provider: "openai",
                        cwd: "/tmp",
                        model: null,
                        status: "running" as const,
                        title: null,
                    }
                },
            })
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            const first = JSON.parse(
                ((await toolDef.execute({}, mockContext())) as { output: string }).output,
            )
            const second = JSON.parse(
                ((await toolDef.execute({}, mockContext())) as { output: string }).output,
            )

            assert.equal(first.position, 1)
            assert.equal(second.position, 2)
            assert.equal(state.activeWorkerLaunchId, first.launchId)

            firstCreate.resolve({
                id: "w5",
                provider: "openai",
                cwd: "/tmp",
                model: null,
                status: "running",
                title: null,
            })
            await flushAsyncWork()
        })

        await t.test("binds worker to session after queued launch completes", async () => {
            const state = createPluginState()
            const launchComplete = createDeferred<{
                id: string
                provider: string
                cwd: string
                model: string | null
                status: "running"
                title: null
            }>()
            const client = createMockTransport({
                createWorker: async () => launchComplete.promise,
            })
            const opencode = mockOpencodeClient()
            const workerLaunchQueue = createWorkerLaunchQueueController(
                state,
                client,
                opencode,
                logger,
            )

            const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
            await toolDef.execute({}, mockContext())

            launchComplete.resolve({
                id: "w5",
                provider: "openai",
                cwd: "/tmp",
                model: null,
                status: "running",
                title: null,
            })
            await flushAsyncWork()

            assert.ok(state.workers.has("w5"))
            const session = state.sessions.get("sess-1")
            assert.ok(session)
            assert.ok(session.createdWorkerIds.has("w5"))
        })

        await t.test(
            "paseo_worker_launch_status returns queued, starting, created, and failed states",
            async () => {
                const state = createPluginState()
                const firstLaunch = createDeferred<{
                    id: string
                    provider: string
                    cwd: string
                    model: string | null
                    status: "running"
                    title: null
                }>()
                let callCount = 0
                const client = createMockTransport({
                    createWorker: async () => {
                        callCount += 1
                        if (callCount === 1) {
                            return firstLaunch.promise
                        }
                        throw new Error("daemon unavailable")
                    },
                })
                const opencode = mockOpencodeClient()
                const workerLaunchQueue = createWorkerLaunchQueueController(
                    state,
                    client,
                    opencode,
                    logger,
                )

                const createTool = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
                const statusTool = createWorkerLaunchStatusTool(workerLaunchQueue, logger)

                const first = JSON.parse(
                    ((await createTool.execute({}, mockContext())) as { output: string }).output,
                )
                const second = JSON.parse(
                    ((await createTool.execute({}, mockContext())) as { output: string }).output,
                )

                const queued = JSON.parse(
                    (
                        (await statusTool.execute(
                            { launchId: second.launchId },
                            mockContext(),
                        )) as {
                            output: string
                        }
                    ).output,
                )
                assert.equal(queued.status, "queued")
                assert.equal(queued.position, 1)
                assert.equal(queued.workerId, undefined)

                const starting = JSON.parse(
                    (
                        (await statusTool.execute({ launchId: first.launchId }, mockContext())) as {
                            output: string
                        }
                    ).output,
                )
                assert.equal(starting.status, "starting")
                assert.equal(typeof starting.startedAt, "string")

                firstLaunch.resolve({
                    id: "w-started",
                    provider: "opencode",
                    cwd: "/tmp",
                    model: null,
                    status: "running",
                    title: null,
                })
                await flushAsyncWork()

                const created = JSON.parse(
                    (
                        (await statusTool.execute({ launchId: first.launchId }, mockContext())) as {
                            output: string
                        }
                    ).output,
                )
                assert.equal(created.status, "created")
                assert.equal(created.workerId, "w-started")
                assert.equal(typeof created.finishedAt, "string")

                await flushAsyncWork()
                const failed = JSON.parse(
                    (
                        (await statusTool.execute(
                            { launchId: second.launchId },
                            mockContext(),
                        )) as {
                            output: string
                        }
                    ).output,
                )
                assert.equal(failed.status, "failed")
                assert.match(failed.error, /daemon unavailable/)

                await assert.rejects(
                    () => statusTool.execute({ launchId: "missing-launch" }, mockContext()),
                    /Worker launch "missing-launch" not found/,
                )
            },
        )
    })

    await t.test("refreshes local state after successful update", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            updateWorker: async (opts) => ({
                workerId: opts.workerId,
                updated: true,
                metadataUpdated: true,
                settingsUpdated: false,
                errors: [],
            }),
            fetchWorker: async () => ({
                agent: {
                    id: "w1",
                    provider: "test",
                    cwd: "/tmp",
                    model: "gpt-5",
                    status: "idle",
                    title: "Updated Worker",
                    labels: {},
                    requiresAttention: false,
                },
                project: null,
            }),
        })

        const toolDef = createWorkerUpdateTool(state, client, logger)
        await toolDef.execute({ workerId: "w1", name: "Updated" }, mockContext())

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.equal(worker.title, "Updated Worker")
        assert.equal(worker.model, "gpt-5")
    })

    await t.test("handles update with only workerId (no changes)", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            updateWorker: async (opts) => ({
                workerId: opts.workerId,
                updated: false,
                metadataUpdated: false,
                settingsUpdated: false,
                errors: [],
            }),
        })

        const toolDef = createWorkerUpdateTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.updated, false)
    })

    await t.test("throws when worker not in state", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const toolDef = createWorkerUpdateTool(state, client, logger)
        await assert.rejects(
            () => toolDef.execute({ workerId: "nonexistent" }, mockContext()),
            /not found in local state/,
        )
    })
})

// ─── Inspect Tool Tests ──────────────────────────────────────────────────────

test("paseo_worker_inspect", async (t) => {
    const logger = new Logger(false)

    await t.test("returns snapshot without activity by default", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let activityCalled = false
        const client = createMockTransport({
            fetchWorkerActivity: async () => {
                activityCalled = true
                return { workerId: "w1", activity: null }
            },
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())

        assert.ok(!activityCalled)
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.worker.id, "w1")
        assert.equal(output.worker.source, "local-cache")
        assert.equal(output.worker.rawStatus, "running")
        assert.equal(output.progress.activityState, "unknown")
        assert.equal(output.progress.summary, "Activity not fetched; worker status is running")
        assert.equal(output.runtimeInfo, undefined)
        assert.equal(output.project, undefined)
        assert.equal(output.activity, undefined)
    })

    await t.test("includes projected activity when requested", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            fetchWorkerActivity: async (opts) => ({
                workerId: opts.workerId,
                activity: {
                    entries: [
                        {
                            kind: "message",
                            timestamp: "2024-01-01T00:00:00Z",
                            summary: "hello",
                        },
                    ],
                    hasMore: false,
                },
            }),
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        const result = await toolDef.execute(
            { workerId: "w1", includeActivity: true },
            mockContext(),
        )

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.worker.id, "w1")
        assert.deepEqual(output.activity.entries[0], {
            kind: "message",
            timestamp: "2024-01-01T00:00:00Z",
            summary: "hello",
        })
        assert.equal(output.progress.activityState, "active")
        assert.equal(output.progress.summary, "hello")
    })

    await t.test("returns null activity when activity fetch fails with not found", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            fetchWorkerActivity: async () => ({
                workerId: "w1",
                activity: null,
            }),
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        const result = await toolDef.execute(
            { workerId: "w1", includeActivity: true },
            mockContext(),
        )

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.activity, null)
        assert.equal(output.progress.activityState, "quiet")
    })

    await t.test("passes activityLimit to transport", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        let receivedLimit: number | undefined
        const client = createMockTransport({
            fetchWorkerActivity: async (opts) => {
                receivedLimit = opts.limit
                return { workerId: opts.workerId, activity: { entries: [], hasMore: false } }
            },
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        await toolDef.execute(
            { workerId: "w1", includeActivity: true, activityLimit: 10 },
            mockContext(),
        )

        assert.equal(receivedLimit, 10)
    })

    await t.test(
        "uses fresh daemon data and exposes raw status plus attention fields",
        async () => {
            const state = createPluginState()
            seedWorker(state, "w1")
            const client = createMockTransport({
                fetchWorker: async () => ({
                    agent: {
                        id: "w1",
                        provider: "codex",
                        cwd: "/repo",
                        model: "gpt-4",
                        status: "initializing",
                        title: "Fresh Title",
                        labels: {},
                        requiresAttention: true,
                        attentionReason: "permission",
                        pendingPermissions: [{ id: "perm-9" }],
                    },
                    project: { id: "proj-1" },
                }),
            })

            const toolDef = createWorkerInspectTool(state, client, logger)
            const result = await toolDef.execute({ workerId: "w1" }, mockContext())

            const output = JSON.parse((result as { output: string }).output)
            assert.equal(output.worker.title, "Fresh Title")
            assert.equal(output.worker.status, "blocked")
            assert.equal(output.worker.rawStatus, "initializing")
            assert.equal(output.worker.source, "daemon")
            assert.equal(output.attention.requiresAttention, true)
            assert.equal(output.attention.attentionReason, "permission")
            assert.equal(output.attention.pendingPermissionCount, 1)
            assert.equal(output.attention.blockingAction, "paseo_permission_respond")
            assert.equal(output.project, undefined)
        },
    )

    await t.test("distinguishes quiet from active running workers", async () => {
        const state = createPluginState()
        seedWorker(state, "w1")
        const client = createMockTransport({
            fetchWorkerActivity: async () => ({
                workerId: "w1",
                activity: { entries: [], hasMore: false },
            }),
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        const result = await toolDef.execute(
            { workerId: "w1", includeActivity: true },
            mockContext(),
        )

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.progress.activityState, "quiet")
        assert.match(output.progress.summary, /running but has no recent projected activity/)
    })

    await t.test("falls back to local state when daemon fetch returns null", async () => {
        const state = createPluginState()
        const worker = seedWorker(state, "w1")
        worker.requiresAttention = true
        worker.attentionReason = "needs input"
        const client = createMockTransport({
            fetchWorker: async () => null,
        })

        const toolDef = createWorkerInspectTool(state, client, logger)
        const result = await toolDef.execute({ workerId: "w1" }, mockContext())

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.worker.source, "local-cache")
        assert.equal(output.attention.requiresAttention, true)
        assert.equal(output.attention.attentionReason, "needs input")
    })

    await t.test("throws when worker not found anywhere", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const toolDef = createWorkerInspectTool(state, client, logger)
        await assert.rejects(
            () => toolDef.execute({ workerId: "nonexistent" }, mockContext()),
            /not found/,
        )
    })
})
