import test from "node:test"
import assert from "node:assert/strict"
import { PaseoClient } from "../../lib/transport/client.js"
import type { DaemonConfig } from "../../lib/config.js"

// ─── Real Daemon Integration Tests ──────────────────────────────────────────
// These tests connect to a real Paseo daemon running on localhost.
// Set PASEO_DAEMON_PORT to override the default port (6767).
// Tests are skipped if the daemon is not reachable.

const DAEMON_PORT = parseInt(process.env.PASEO_DAEMON_PORT || "6767", 10)
const DAEMON_HOST = process.env.PASEO_DAEMON_HOST || "127.0.0.1"
const DAEMON_PASSWORD = process.env.PASEO_DAEMON_PASSWORD || undefined

function createDaemonConfig(): DaemonConfig {
  return {
    host: DAEMON_HOST,
    port: DAEMON_PORT,
    connectionTimeoutMs: 5000,
    password: DAEMON_PASSWORD,
  }
}

async function isDaemonReachable(): Promise<boolean> {
  const client = new PaseoClient(createDaemonConfig())
  try {
    await client.connect()
    await client.close()
    return true
  } catch {
    return false
  }
}

test("real daemon integration", async (t) => {
  const reachable = await isDaemonReachable()
  if (!reachable) {
    t.skip(`Paseo daemon not reachable on ${DAEMON_HOST}:${DAEMON_PORT} — skipping integration tests`)
    return
  }

  await t.test("hello handshake provides server_info via getServerInfo", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()

      const serverInfo = client.getServerInfo()
      assert.ok(serverInfo, "getServerInfo() should return server info after connect")
      assert.ok(typeof serverInfo!.serverId === "string", "serverId should be a string")
      assert.ok(serverInfo!.serverId.length > 0, "serverId should not be empty")
      assert.ok(typeof serverInfo!.capabilities === "object", "capabilities should be an object")

      assert.ok(client.isConnected(), "client should report connected")
    } finally {
      await client.close()
    }
  })

  await t.test("fetchAgents returns an array", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const agents = await client.fetchAgents()

      assert.ok(Array.isArray(agents), "fetchAgents should return an array")

      for (const agent of agents) {
        assert.ok(typeof agent.id === "string", "agent.id should be a string")
        assert.ok(typeof agent.status === "string", "agent.status should be a string")
      }
    } finally {
      await client.close()
    }
  })

  await t.test("listTerminals returns an array", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const terminals = await client.listTerminals()

      assert.ok(Array.isArray(terminals), "listTerminals should return an array")

      for (const terminal of terminals) {
        assert.ok(typeof terminal.id === "string", "terminal.id should be a string")
        assert.ok(typeof terminal.name === "string", "terminal.name should be a string")
      }
    } finally {
      await client.close()
    }
  })

  await t.test("getStatus returns daemon status", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const status = await client.getStatus()

      assert.ok(typeof status === "object", "getStatus should return an object")
      assert.ok(status !== null, "status should not be null")
    } finally {
      await client.close()
    }
  })

  await t.test("event subscription receives events or times out gracefully", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()

      const unsubscribe = client.onEvent((event) => {
        assert.ok(typeof event.type === "string", "event.type should be a string")
        assert.ok(typeof event.payload === "object", "event.payload should be an object")
      })

      // Wait briefly for any server-pushed events
      await new Promise((resolve) => setTimeout(resolve, 1000))

      unsubscribe()
      assert.ok(true, "event subscription and unsubscribe completed")
    } finally {
      await client.close()
    }
  })

  await t.test("close cleans up and rejects pending requests", async () => {
    const client = new PaseoClient(createDaemonConfig())
    await client.connect()

    assert.ok(client.isConnected(), "should be connected")

    await client.close()

    assert.ok(!client.isConnected(), "should be disconnected")
    assert.equal(client.getServerInfo(), null, "serverInfo should be null after close")

    await assert.rejects(() => client.fetchAgents())
  })

  await t.test("multiple sequential requests work", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()

      const agents = await client.fetchAgents()
      const terminals = await client.listTerminals()
      const status = await client.getStatus()

      assert.ok(Array.isArray(agents), "agents should be array")
      assert.ok(Array.isArray(terminals), "terminals should be array")
      assert.ok(typeof status === "object", "status should be object")
    } finally {
      await client.close()
    }
  })

  // ─── Phase 3: Worker Operations ──────────────────────────────────────

  await t.test("listWorktrees returns an object", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const result = await client.listWorktrees({ cwd: process.cwd() })

      assert.ok(typeof result === "object", "listWorktrees should return an object")
      assert.ok(result !== null, "result should not be null")
    } finally {
      await client.close()
    }
  })

  await t.test("fetchWorker returns null for unknown worker", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const result = await client.fetchWorker("nonexistent-worker-id")

      assert.equal(result, null, "fetchWorker should return null for unknown worker")
    } finally {
      await client.close()
    }
  })

  await t.test("getProvidersSnapshot returns an array", async () => {
    const client = new PaseoClient(createDaemonConfig())
    try {
      await client.connect()
      const providers = await client.getProvidersSnapshot(process.cwd())

      assert.ok(Array.isArray(providers), "getProvidersSnapshot should return an array")
    } finally {
      await client.close()
    }
  })
})
