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
} from "../lib/state/state.js"
import type { InboxEvent, TerminalSessionSummary, WorkerSummary } from "../lib/state/types.js"

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
            status: "running",
            cwd: "/tmp",
            labels: [],
            unreadEventCount: 0,
            pendingPermissionIds: [],
        }
        upsertWorker(state, worker)
        assert.equal(state.workers.size, 1)
        assert.equal(state.workers.get("w1")!.agent, "general")
    })
})
