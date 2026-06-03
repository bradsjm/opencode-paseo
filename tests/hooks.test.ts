import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState, insertInboxEvent } from "../lib/state/state.js"
import { createDaemonEventHandler } from "../lib/hooks.js"
import { Logger } from "../lib/logger.js"
import type { PluginConfig } from "../lib/config.js"

const mockConfig: PluginConfig = {
    enabled: true,
    debug: false,
    daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
    output: { maxInboxItems: 100, maxSummaryLength: 500 },
    notifications: { enabled: true, blockingOnly: false },
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
            payload: { workerId: "w1", summary: "Write permission needed" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.kind, "permission.requested")
        assert.equal(event.blocking, true)
    })

    await t.test("ignores unknown event types", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({ type: "unknown.event", payload: {} })

        assert.equal(state.inbox.size, 0)
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

    await t.test("handles terminal.error as blocking", () => {
        const state = createPluginState()
        const handler = createDaemonEventHandler(state, logger, mockConfig)

        handler({
            type: "terminal.error",
            payload: { terminalId: "t1", summary: "Terminal crashed" },
        })

        const event = Array.from(state.inbox.values())[0]
        assert.equal(event.kind, "terminal.error")
        assert.equal(event.blocking, true)
        assert.equal(event.resourceId, "t1")
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
                summary: "Permission resolved",
            },
        })

        const worker = state.workers.get("w1")
        assert.ok(worker)
        assert.ok(!worker.pendingPermissionIds.includes("perm-1"))
        assert.equal(worker.pendingPermissions.length, 0)
    })
})
