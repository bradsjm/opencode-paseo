import test from "node:test"
import assert from "node:assert/strict"
import {
    createPluginState,
    resetPluginState,
    setConnectionStatus,
    setCapabilities,
    getOrCreateSession,
    insertInboxEvent,
    markEventRead,
    markAllRead,
    upsertTerminal,
    upsertWorker,
    recordCreatedWorker,
    mapAgentToWorkerSummary,
    removeSession,
    unbindWorkerFromSessions,
    unbindTerminalFromSessions,
    recordCreatedTerminal,
} from "../lib/state/state.js"
import type { InboxEvent, TerminalSessionSummary, WorkerSummary } from "../lib/state/types.js"
import type { AgentSummary } from "../lib/transport/types.js"

// ─── State Creation ──────────────────────────────────────────────────────────

test("createPluginState", async (t) => {
    await t.test("creates empty state", () => {
        const state = createPluginState()
        assert.equal(state.connectionStatus, "disconnected")
        assert.equal(state.capabilities, null)
        assert.equal(state.sessions.size, 0)
        assert.equal(state.terminals.size, 0)
        assert.equal(state.workers.size, 0)
        assert.equal(state.inbox.size, 0)
        assert.equal(state.eventCounter, 0)
    })
})

test("resetPluginState", async (t) => {
    await t.test("clears all state", () => {
        const state = createPluginState()
        setConnectionStatus(state, "connected")
        state.inbox.set("evt-1", {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "test",
            read: false,
            timestamp: Date.now(),
        })
        resetPluginState(state)
        assert.equal(state.connectionStatus, "disconnected")
        assert.equal(state.inbox.size, 0)
    })
})

// ─── Connection Status ───────────────────────────────────────────────────────

test("setConnectionStatus", async (t) => {
    await t.test("sets status and clears error on connected", () => {
        const state = createPluginState()
        setConnectionStatus(state, "error", "timeout")
        setConnectionStatus(state, "connected")
        assert.equal(state.connectionStatus, "connected")
        assert.equal(state.lastError, undefined)
    })

    await t.test("sets error message", () => {
        const state = createPluginState()
        setConnectionStatus(state, "error", "connection refused")
        assert.equal(state.lastError, "connection refused")
    })
})

// ─── Session Management ──────────────────────────────────────────────────────

test("getOrCreateSession", async (t) => {
    await t.test("creates new session", () => {
        const state = createPluginState()
        const session = getOrCreateSession(state, "sess-1", "/project")
        assert.equal(session.opencodeSessionId, "sess-1")
        assert.equal(session.projectRoot, "/project")
        assert.equal(state.sessions.size, 1)
    })

    await t.test("returns existing session", () => {
        const state = createPluginState()
        const s1 = getOrCreateSession(state, "sess-1", "/project")
        const s2 = getOrCreateSession(state, "sess-1", "/project")
        assert.equal(s1, s2)
        assert.equal(state.sessions.size, 1)
    })
})

// ─── Inbox Operations ────────────────────────────────────────────────────────

test("insertInboxEvent", async (t) => {
    await t.test("inserts new event", () => {
        const state = createPluginState()
        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "Worker started",
            read: false,
            timestamp: Date.now(),
        }
        const inserted = insertInboxEvent(state, event)
        assert.equal(inserted, true)
        assert.equal(state.inbox.size, 1)
        assert.equal(state.eventCounter, 1)
    })

    await t.test("deduplicates by ID", () => {
        const state = createPluginState()
        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "Worker started",
            read: false,
            timestamp: Date.now(),
        }
        insertInboxEvent(state, event)
        const inserted2 = insertInboxEvent(state, event)
        assert.equal(inserted2, false)
        assert.equal(state.inbox.size, 1)
    })

    await t.test("adds blocking event to session pending permissions", () => {
        const state = createPluginState()
        const session = getOrCreateSession(state, "sess-1", "/project")
        session.createdWorkerIds.add("w1")

        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.blocked",
            resourceId: "w1",
            blocking: true,
            summary: "Worker blocked",
            read: false,
            timestamp: Date.now(),
        }
        insertInboxEvent(state, event)
        assert.equal(session.unreadEvents.size, 1)
        assert.equal(session.pendingPermissions.size, 1)
    })
})

test("markEventRead", async (t) => {
    await t.test("marks event as read", () => {
        const state = createPluginState()
        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "test",
            read: false,
            timestamp: Date.now(),
        }
        insertInboxEvent(state, event)
        markEventRead(state, "evt-1")
        assert.equal(state.inbox.get("evt-1")!.read, true)
    })
})

test("markAllRead", async (t) => {
    await t.test("marks all events as read", () => {
        const state = createPluginState()
        for (let i = 0; i < 5; i++) {
            insertInboxEvent(state, {
                id: `evt-${i}`,
                kind: "worker.started",
                resourceId: `w${i}`,
                blocking: false,
                summary: "test",
                read: false,
                timestamp: Date.now(),
            })
        }
        markAllRead(state)
        for (const event of state.inbox.values()) {
            assert.equal(event.read, true)
        }
    })
})

// ─── Terminal / Worker Upsert ────────────────────────────────────────────────

test("upsertTerminal", async (t) => {
    await t.test("adds terminal to state", () => {
        const state = createPluginState()
        const terminal: TerminalSessionSummary = {
            id: "t1",
            title: "test terminal",
            cwd: "/tmp",
            status: "running",
            lineCount: 100,
            lastReadCursor: 0,
        }
        upsertTerminal(state, terminal)
        assert.equal(state.terminals.size, 1)
        assert.equal(state.terminals.get("t1")!.title, "test terminal")
    })
})

test("upsertWorker", async (t) => {
    await t.test("adds worker to state", () => {
        const state = createPluginState()
        const worker: WorkerSummary = {
            id: "w1",
            title: "test worker",
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
        upsertWorker(state, worker)
        assert.equal(state.workers.size, 1)
        assert.equal(state.workers.get("w1")!.agent, "general")
        assert.equal(state.workers.get("w1")!.provider, "general")
    })
})

// ─── recordCreatedWorker ─────────────────────────────────────────────────────

test("recordCreatedWorker", async (t) => {
    await t.test("binds worker to session createdWorkerIds", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")

        const worker: WorkerSummary = {
            id: "w1",
            title: "new worker",
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
        recordCreatedWorker(state, "sess-1", worker)

        assert.equal(state.workers.size, 1)
        const session = state.sessions.get("sess-1")!
        assert.ok(session.createdWorkerIds.has("w1"))
    })

    await t.test("routes inbox events for created worker to session", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")

        const worker: WorkerSummary = {
            id: "w1",
            title: "new worker",
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
        recordCreatedWorker(state, "sess-1", worker)

        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "Worker started",
            read: false,
            timestamp: Date.now(),
        }
        insertInboxEvent(state, event)

        const session = state.sessions.get("sess-1")!
        assert.equal(session.unreadEvents.size, 1)
    })
})

// ─── mapAgentToWorkerSummary ─────────────────────────────────────────────────

test("mapAgentToWorkerSummary", async (t) => {
    await t.test("maps core fields from AgentSummary", () => {
        const agent: AgentSummary = {
            id: "a1",
            provider: "codex",
            cwd: "/repo",
            model: "gpt-4",
            status: "running",
            title: "Agent 1",
            labels: { lane: "main" },
            pendingPermissions: [{ id: "perm-1", type: "write" }],
            runtimeInfo: { currentModeId: "code" },
        }

        const worker = mapAgentToWorkerSummary(agent)

        assert.equal(worker.id, "a1")
        assert.equal(worker.provider, "codex")
        assert.equal(worker.agent, "codex")
        assert.equal(worker.model, "gpt-4")
        assert.equal(worker.currentModeId, "code")
        assert.equal(worker.status, "running")
        assert.deepEqual(worker.labels, ["lane"])
        assert.deepEqual(worker.pendingPermissionIds, ["perm-1"])
        assert.equal(worker.pendingPermissions.length, 1)
    })

    await t.test("derives blocked status from pending permissions", () => {
        const agent: AgentSummary = {
            id: "a2",
            provider: "codex",
            cwd: "/repo",
            model: null,
            status: "running",
            title: null,
            labels: {},
            requiresAttention: true,
            attentionReason: "permission",
            pendingPermissions: [{ id: "p1" }],
        }

        const worker = mapAgentToWorkerSummary(agent)
        assert.equal(worker.status, "blocked")
    })

    await t.test("handles missing optional fields", () => {
        const agent: AgentSummary = {
            id: "a3",
            provider: "unknown",
            cwd: "",
            model: null,
            status: "idle",
            title: null,
            labels: {},
        }

        const worker = mapAgentToWorkerSummary(agent)
        assert.equal(worker.currentModeId, null)
        assert.equal(worker.runtimeInfo, null)
        assert.equal(worker.persistence, null)
        assert.deepEqual(worker.pendingPermissionIds, [])
    })
})

// ─── removeSession ───────────────────────────────────────────────────────────

test("removeSession", async (t) => {
    await t.test("removes session and clears bindings", () => {
        const state = createPluginState()
        const session = getOrCreateSession(state, "sess-1", "/project")
        session.createdWorkerIds.add("w1")
        session.createdTerminalIds.add("t1")

        // Add an unread event to the session
        const event: InboxEvent = {
            id: "evt-1",
            kind: "worker.started",
            resourceId: "w1",
            blocking: false,
            summary: "test",
            read: false,
            timestamp: Date.now(),
        }
        insertInboxEvent(state, event)
        assert.equal(session.unreadEvents.size, 1)

        const removed = removeSession(state, "sess-1")
        assert.equal(removed, true)
        assert.equal(state.sessions.size, 0)
    })

    await t.test("returns false for unknown session", () => {
        const state = createPluginState()
        const removed = removeSession(state, "unknown")
        assert.equal(removed, false)
    })

    await t.test("does not delete global worker/terminal entries", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")

        const worker: WorkerSummary = {
            id: "w1",
            title: "worker",
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
        recordCreatedWorker(state, "sess-1", worker)

        const terminal: TerminalSessionSummary = {
            id: "t1",
            title: "terminal",
            cwd: "/tmp",
            status: "running",
            lineCount: 0,
            lastReadCursor: 0,
        }
        recordCreatedTerminal(state, "sess-1", terminal)

        assert.equal(state.workers.size, 1)
        assert.equal(state.terminals.size, 1)

        removeSession(state, "sess-1")

        // Global entries should still exist
        assert.equal(state.workers.size, 1)
        assert.equal(state.terminals.size, 1)
    })
})

// ─── unbindWorkerFromSessions ────────────────────────────────────────────────

test("unbindWorkerFromSessions", async (t) => {
    await t.test("removes worker ID from all sessions", () => {
        const state = createPluginState()
        const s1 = getOrCreateSession(state, "sess-1", "/project")
        const s2 = getOrCreateSession(state, "sess-2", "/project")
        s1.createdWorkerIds.add("w1")
        s2.createdWorkerIds.add("w1")
        s2.createdWorkerIds.add("w2")

        unbindWorkerFromSessions(state, "w1")

        assert.ok(!s1.createdWorkerIds.has("w1"))
        assert.ok(!s2.createdWorkerIds.has("w1"))
        assert.ok(s2.createdWorkerIds.has("w2"))
    })

    await t.test("is a no-op for unknown worker", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        unbindWorkerFromSessions(state, "unknown")
        // Should not throw
    })
})

// ─── unbindTerminalFromSessions ──────────────────────────────────────────────

test("unbindTerminalFromSessions", async (t) => {
    await t.test("removes terminal ID from all sessions", () => {
        const state = createPluginState()
        const s1 = getOrCreateSession(state, "sess-1", "/project")
        const s2 = getOrCreateSession(state, "sess-2", "/project")
        s1.createdTerminalIds.add("t1")
        s2.createdTerminalIds.add("t1")
        s2.createdTerminalIds.add("t2")

        unbindTerminalFromSessions(state, "t1")

        assert.ok(!s1.createdTerminalIds.has("t1"))
        assert.ok(!s2.createdTerminalIds.has("t1"))
        assert.ok(s2.createdTerminalIds.has("t2"))
    })

    await t.test("is a no-op for unknown terminal", () => {
        const state = createPluginState()
        getOrCreateSession(state, "sess-1", "/project")
        unbindTerminalFromSessions(state, "unknown")
        // Should not throw
    })
})
