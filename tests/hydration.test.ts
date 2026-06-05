import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import { hydrate } from "../lib/hydration/hydrate.js"

const outputConfig = { maxInboxItems: 100, maxSummaryLength: 32 }

// ─── Mock Paseo Transport ────────────────────────────────────────────────────

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
    const base: PaseoTransport = {
        isConnected: () => true,
        connect: async () => {},
        close: async () => {},
        getServerInfo: () => ({
            serverId: "test-server",
            version: "0.1.0",
            features: { workers: true, terminals: true },
            capabilities: {},
        }),
        fetchAgents: async () => [
            {
                id: "w1",
                title: "Worker 1",
                provider: "general",
                status: "running",
                cwd: "/tmp",
                model: null,
                labels: {},
                requiresAttention: false,
            },
            {
                id: "w2",
                title: "Worker 2",
                provider: "explore",
                status: "idle",
                cwd: "/tmp",
                model: null,
                labels: {},
                requiresAttention: true,
                attentionReason: "permission",
            },
        ],
        listTerminals: async () => [{ id: "t1", name: "main", title: "Terminal 1" }],
        getStatus: async () => ({ status: "ok", version: "0.1.0", uptime: 1234 }),
        getProvidersSnapshot: async () => [],
        onEvent: () => () => {},
        createTerminal: async (options) => ({
            id: `t-${Date.now()}`,
            name: options.name ?? "terminal",
            cwd: options.cwd,
        }),
        captureTerminal: async (options) => ({
            terminalId: options.terminalId,
            content: "",
            lineCount: 0,
            truncated: false,
        }),
        sendTerminalInput: () => {},
        killTerminal: async (terminalId) => ({ id: terminalId, exitCode: null }),
        respondToPermission: async (options) => ({
            workerId: options.workerId,
            permissionId: options.permissionId,
            behavior: options.behavior,
        }),
        createChatRoom: async () => ({ requestId: "req", room: null, error: null }),
        listChatRooms: async () => ({ requestId: "req", rooms: [], error: null }),
        inspectChatRoom: async () => ({ requestId: "req", room: null, error: null }),
        deleteChatRoom: async () => ({ requestId: "req", room: null, error: null }),
        postChatMessage: async () => ({ requestId: "req", message: null, error: null }),
        readChatMessages: async () => ({ requestId: "req", messages: [], error: null }),
        waitForChatMessages: async () => ({
            requestId: "req",
            messages: [],
            timedOut: true,
            error: null,
        }),
        // Phase 3: Worker operations
        createWorker: async (options) => ({
            id: `w-${Date.now()}`,
            provider: options.provider ?? "unknown",
            cwd: options.cwd,
            model: options.model ?? null,
            status: "running",
            title: null,
        }),
        sendWorkerMessage: async () => {},
        waitForWorker: async (workerId) => ({
            status: "idle" as const,
            workerId,
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
        updateWorker: async (options) => ({
            workerId: options.workerId,
            updated: false,
            metadataUpdated: false,
            settingsUpdated: false,
            errors: [],
        }),
        fetchWorkerActivity: async (options) => ({
            workerId: options.workerId,
            activity: null,
        }),
        // Phase 3: Worktree operations
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
    }

    return { ...base, ...overrides }
}

// ─── Hydration Tests ─────────────────────────────────────────────────────────

test("hydrate", async (t) => {
    const logger = new Logger(false)

    await t.test("successful hydration populates state", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const result = await hydrate(state, client, logger, outputConfig)

        assert.equal(result.workers, 2)
        assert.equal(result.terminals, 1)
        assert.equal(result.chatRooms, 0)
        assert.equal(state.connectionStatus, "connected")
        assert.equal(state.workers.size, 2)
        assert.equal(state.terminals.size, 1)
        assert.ok(state.capabilities)
    })

    await t.test("seeds blocking inbox items for blocked workers", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const result = await hydrate(state, client, logger, outputConfig)

        // w2 is blocked = 1 blocking event
        assert.ok(result.inboxSeeded >= 1)
        const blockingEvents = Array.from(state.inbox.values()).filter((e) => e.blocking)
        assert.ok(blockingEvents.length >= 1)
        assert.equal(blockingEvents[0]?.kind, "worker.blocked")
        assert.equal(blockingEvents[0]?.metadata?.suggestedTool, "paseo_worker_send")
    })

    await t.test("seeds permission.requested for permission-blocked workers", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            fetchAgents: async () => [
                {
                    id: "w-perm",
                    title: "Worker Permission",
                    provider: "general",
                    status: "running",
                    cwd: "/tmp",
                    model: null,
                    labels: {},
                    requiresAttention: true,
                    attentionReason: "A very long permission request summary that should truncate",
                    pendingPermissions: [{ id: "perm-1", type: "write" }],
                },
            ],
        })

        await hydrate(state, client, logger, outputConfig)

        const event = state.inbox.get("hydration-permission-perm-1")
        assert.ok(event)
        assert.equal(event.kind, "permission.requested")
        assert.equal(event.metadata?.permissionId, "perm-1")
        assert.equal(event.metadata?.suggestedTool, "paseo_permission_respond")
        assert.ok(event.summary.length <= outputConfig.maxSummaryLength)
    })

    await t.test("handles missing server info gracefully", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            getServerInfo: () => null,
        })

        const result = await hydrate(state, client, logger, outputConfig)

        // Still proceeds with agent/terminal hydration
        assert.equal(result.workers, 2)
        assert.equal(result.terminals, 1)
    })

    await t.test("tolerates agent fetch failure", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            fetchAgents: async () => {
                throw new Error("Agents endpoint unavailable")
            },
        })

        const result = await hydrate(state, client, logger, outputConfig)

        assert.equal(result.workers, 0)
        assert.equal(result.terminals, 1) // terminals still work
        assert.equal(state.connectionStatus, "connected")
    })

    await t.test("tolerates terminal fetch failure", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            listTerminals: async () => {
                throw new Error("Terminals endpoint unavailable")
            },
        })

        const result = await hydrate(state, client, logger, outputConfig)

        assert.equal(result.workers, 2) // agents still work
        assert.equal(result.terminals, 0)
        assert.equal(state.connectionStatus, "connected")
    })

    await t.test("does not duplicate events on re-hydration", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        await hydrate(state, client, logger, outputConfig)
        const firstCount = state.inbox.size
        const firstWorkerCount = state.workers.size
        const firstTerminalCount = state.terminals.size

        // Re-hydrate with same data
        await hydrate(state, client, logger, outputConfig)
        assert.equal(state.inbox.size, firstCount) // dedup prevents duplicates
        assert.equal(state.workers.size, firstWorkerCount)
        assert.equal(state.terminals.size, firstTerminalCount)
    })

    await t.test("does not synthesize stall inbox events during hydration", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            fetchAgents: async () => [
                {
                    id: "w-running",
                    title: "Running Worker",
                    provider: "general",
                    status: "running",
                    cwd: "/tmp",
                    model: null,
                    labels: {},
                    requiresAttention: false,
                    updatedAt: new Date(Date.now() - 600000).toISOString(),
                },
            ],
        })

        await hydrate(state, client, logger, outputConfig)

        assert.equal(
            Array.from(state.inbox.values()).some((event) => event.kind === "worker.stalled"),
            false,
        )
        assert.ok(state.workers.get("w-running")?.updatedAt)
    })

    await t.test("populates Phase 3 worker fields", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            fetchAgents: async () => [
                {
                    id: "w-rich",
                    title: "Rich Worker",
                    provider: "codex",
                    status: "running",
                    cwd: "/repo",
                    model: "gpt-4",
                    labels: { lane: "main" },
                    requiresAttention: false,
                    runtimeInfo: { currentModeId: "code" },
                    pendingPermissions: [{ id: "perm-1" }],
                    worktreePath: "/repo/.worktrees/feature",
                    branchName: "feature/test",
                },
            ],
        })

        await hydrate(state, client, logger, outputConfig)

        const worker = state.workers.get("w-rich")
        assert.ok(worker)
        assert.equal(worker.provider, "codex")
        assert.equal(worker.model, "gpt-4")
        assert.equal(worker.currentModeId, "code")
        assert.equal(worker.worktreePath, "/repo/.worktrees/feature")
        assert.equal(worker.branchName, "feature/test")
        assert.deepEqual(worker.pendingPermissionIds, ["perm-1"])
        assert.equal(worker.pendingPermissions.length, 1)
    })

    await t.test("hydrates worker chatRoom from reserved label and tracks room count", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            fetchAgents: async () => [
                {
                    id: "w-chat",
                    title: "Chat Worker",
                    provider: "codex",
                    status: "running",
                    cwd: "/repo",
                    model: null,
                    labels: {
                        lane: "main",
                        "opencodePaseo.chatRoom": "ops-room",
                    },
                    requiresAttention: false,
                },
            ],
        })

        const result = await hydrate(state, client, logger, outputConfig)

        assert.equal(result.chatRooms, 1)
        assert.equal(state.workers.get("w-chat")?.chatRoom, "ops-room")
        assert.equal(state.chatRooms.get("ops-room")?.name, "ops-room")
    })
})
