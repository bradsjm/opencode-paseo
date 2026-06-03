import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoClient } from "../lib/transport/client.js"
import { Logger } from "../lib/logger.js"
import { hydrate } from "../lib/hydration/hydrate.js"

// ─── Mock Paseo Client ───────────────────────────────────────────────────────

function createMockClient(overrides: Partial<PaseoClient> = {}): PaseoClient {
    return {
        isConnected: () => true,
        connect: async () => ({
            serverId: "test-server",
            version: "0.1.0",
            features: { workers: true, terminals: true },
            capabilities: {},
        }),
        disconnect: () => {},
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
                labels: {},
                requiresAttention: false,
            },
            {
                id: "w2",
                title: "Worker 2",
                provider: "explore",
                status: "idle",
                cwd: "/tmp",
                labels: {},
                requiresAttention: true,
                attentionReason: "permission",
            },
        ],
        listTerminals: async () => [
            { id: "t1", title: "Terminal 1", cwd: "/tmp", status: "running", lineCount: 50 },
        ],
        getStatus: async () => ({ status: "ok", version: "0.1.0", uptime: 1234 }),
        getProvidersSnapshot: async () => [],
        onEvent: () => () => {},
        ...overrides,
    } as unknown as PaseoClient
}

// ─── Hydration Tests ─────────────────────────────────────────────────────────

test("hydrate", async (t) => {
    const logger = new Logger(false)

    await t.test("successful hydration populates state", async () => {
        const state = createPluginState()
        const client = createMockClient()

        const result = await hydrate(state, client, logger)

        assert.equal(result.workers, 2)
        assert.equal(result.terminals, 1)
        assert.equal(state.connectionStatus, "connected")
        assert.equal(state.workers.size, 2)
        assert.equal(state.terminals.size, 1)
        assert.ok(state.capabilities)
    })

    await t.test("seeds blocking inbox items for blocked workers", async () => {
        const state = createPluginState()
        const client = createMockClient()

        const result = await hydrate(state, client, logger)

        // w2 is blocked = 1 blocking event
        assert.ok(result.inboxSeeded >= 1)
        const blockingEvents = Array.from(state.inbox.values()).filter((e) => e.blocking)
        assert.ok(blockingEvents.length >= 1)
    })

    await t.test("handles missing server info gracefully", async () => {
        const state = createPluginState()
        const client = createMockClient({
            getServerInfo: () => null,
        } as any)

        const result = await hydrate(state, client, logger)

        // Still proceeds with agent/terminal hydration
        assert.equal(result.workers, 2)
        assert.equal(result.terminals, 1)
    })

    await t.test("tolerates agent fetch failure", async () => {
        const state = createPluginState()
        const client = createMockClient({
            fetchAgents: async () => {
                throw new Error("Agents endpoint unavailable")
            },
        } as any)

        const result = await hydrate(state, client, logger)

        assert.equal(result.workers, 0)
        assert.equal(result.terminals, 1) // terminals still work
        assert.equal(state.connectionStatus, "connected")
    })

    await t.test("tolerates terminal fetch failure", async () => {
        const state = createPluginState()
        const client = createMockClient({
            listTerminals: async () => {
                throw new Error("Terminals endpoint unavailable")
            },
        } as any)

        const result = await hydrate(state, client, logger)

        assert.equal(result.workers, 2) // agents still work
        assert.equal(result.terminals, 0)
        assert.equal(state.connectionStatus, "connected")
    })

    await t.test("does not duplicate events on re-hydration", async () => {
        const state = createPluginState()
        const client = createMockClient()

        await hydrate(state, client, logger)
        const firstCount = state.inbox.size

        // Re-hydrate with same data
        await hydrate(state, client, logger)
        assert.equal(state.inbox.size, firstCount) // dedup prevents duplicates
    })
})
