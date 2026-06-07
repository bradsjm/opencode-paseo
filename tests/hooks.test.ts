import test from "node:test"
import assert from "node:assert/strict"
import {
  createPluginState,
  getOrCreateSession,
  insertInboxEvent,
  recordBackgroundWorker,
  registerEphemeralWorkerRun,
} from "../lib/state/state.js"
import { createDaemonEventHandler, createEventHandler } from "../lib/hooks.js"
import { Logger } from "../lib/logger.js"
import type { PluginConfig } from "../lib/config.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import type { OpencodeClient } from "../lib/profile.js"
import type { AgentSummary } from "../lib/transport/types.js"
import type { InboxEvent, WorkerSummary } from "../lib/state/types.js"

const mockConfig: PluginConfig = {
  enabled: true,
  debug: false,
  nudgeEnabled: true,
  workerStallThresholdMs: 120000,
  daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
  output: { maxInboxItems: 100, maxSummaryLength: 500 },
  agents: {},
  task: { enabled: false },
}

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "w1",
    provider: "codex",
    cwd: "/repo",
    model: null,
    status: "running",
    title: "Worker 1",
    labels: {},
    pendingPermissions: [],
    ...overrides,
  }
}

function firstInboxEvent(state: ReturnType<typeof createPluginState>): InboxEvent {
  const event = Array.from(state.inbox.values())[0]
  if (event === undefined) throw new Error("Expected at least one inbox event")
  return event
}

function ownWorker(state: ReturnType<typeof createPluginState>, sessionId = "sess-1", workerId = "w1") {
  const session = getOrCreateSession(state, sessionId, "/project")
  session.createdWorkerIds.add(workerId)
  return session
}

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
        calls.push({ sessionId: args.path.id, text: args.body?.parts?.[0]?.text ?? "" })
        return { data: {} }
      },
    },
  } as unknown as OpencodeClient
  return { client, calls }
}

test("createDaemonEventHandler", async (t) => {
  const logger = new Logger(false)

  await t.test("agent_update running updates worker state without inbox noise", () => {
    const state = createPluginState()
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent() } })

    const worker = state.workers.get("w1")
    assert.ok(worker)
    assert.equal(worker.status, "running")
    assert.equal(worker.rawStatus, "running")
    assert.equal(worker.title, "Worker 1")
    assert.equal(state.inbox.size, 0)
  })

  await t.test("agent_update idle preserves idle and creates compact status event for owned worker", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "idle" }) } })

    assert.equal(state.workers.get("w1")?.status, "idle")
    const event = firstInboxEvent(state)
    assert.equal(event.kind, "agent.status")
    assert.equal(event.resourceId, "w1")
    assert.equal(event.blocking, false)
    assert.equal(event.metadata?.status, "idle")
  })

  await t.test("unchanged actionable status does not duplicate unread status events", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "error" }) } })
    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "error" }) } })

    assert.equal(state.inbox.size, 1)
  })

  await t.test("distinct actionable status transitions each create inbox events", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "idle" }) } })
    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "error" }) } })
    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent({ status: "closed" }) } })

    assert.deepEqual(
      Array.from(state.inbox.values()).map((event) => event.metadata?.status),
      ["idle", "error", "closed"],
    )
  })

  await t.test("non-permission attention creates non-blocking agent.attention metadata", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agentId: "w1",
        agent: agent({ requiresAttention: true, attentionReason: "needs user input" }),
      },
    })

    const event = firstInboxEvent(state)
    assert.equal(event.kind, "agent.attention")
    assert.equal(event.blocking, false)
    assert.equal(event.metadata?.attentionReason, "needs user input")
    assert.equal(event.metadata?.suggestedTool, undefined)
  })

  await t.test("actionable status takes precedence over non-permission attention", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agentId: "w1",
        agent: agent({ status: "error", requiresAttention: true, attentionReason: "error" }),
      },
    })

    const event = firstInboxEvent(state)
    assert.equal(event.kind, "agent.status")
    assert.equal(event.metadata?.status, "error")
  })

  await t.test("permission request creates permission inbox and resolved marks it read", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)
    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent() } })

    handler({
      type: "agent_permission_request",
      payload: { workerId: "w1", permissionId: "perm-1", request: { id: "perm-1", summary: "Write file" } },
    })

    const event = firstInboxEvent(state)
    assert.equal(event.kind, "permission.requested")
    assert.equal(event.blocking, true)
    assert.equal(event.metadata?.suggestedTool, "paseo_permission_respond")
    assert.deepEqual(state.workers.get("w1")?.pendingPermissionIds, ["perm-1"])

    handler({
      type: "agent_permission_resolved",
      payload: { workerId: "w1", permissionId: "perm-1", resolution: { decision: "allow" } },
    })

    assert.equal(event.read, true)
    assert.deepEqual(state.workers.get("w1")?.pendingPermissionIds, [])
  })

  await t.test("permission resolved marks only the matching permission event read", () => {
    const state = createPluginState()
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)
    handler({ type: "agent_update", payload: { kind: "upsert", agentId: "w1", agent: agent() } })

    handler({
      type: "agent_permission_request",
      payload: { workerId: "w1", permissionId: "perm-1", request: { id: "perm-1" } },
    })
    handler({
      type: "agent_permission_request",
      payload: { workerId: "w1", permissionId: "perm-2", request: { id: "perm-2" } },
    })
    handler({
      type: "agent_permission_resolved",
      payload: { workerId: "w1", permissionId: "perm-1", resolution: { decision: "allow" } },
    })

    const events = Array.from(state.inbox.values())
    assert.equal(events.find((event) => event.metadata?.permissionId === "perm-1")?.read, true)
    assert.equal(events.find((event) => event.metadata?.permissionId === "perm-2")?.read, false)
    assert.deepEqual(state.workers.get("w1")?.pendingPermissionIds, ["perm-2"])
  })

  await t.test("agent_stream is state/inbox noise-free", () => {
    const state = createPluginState()
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_stream", payload: { workerId: "w1", timestamp: new Date().toISOString() } })

    assert.equal(state.inbox.size, 0)
  })

  await t.test("agent_deleted removes worker without completion inbox", () => {
    const state = createPluginState()
    state.workers.set("w1", workerSummary())
    ownWorker(state)
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "agent_deleted", payload: { agentId: "w1" } })

    assert.equal(state.workers.has("w1"), false)
    assert.equal(state.inbox.size, 0)
  })

  await t.test("worker.stalled still creates non-blocking inbox", () => {
    const state = createPluginState()
    const handler = createDaemonEventHandler(state, logger, mockConfig)

    handler({ type: "worker.stalled", payload: { workerId: "w1", summary: "Worker w1 appears stalled" } })

    const event = firstInboxEvent(state)
    assert.equal(event.kind, "worker.stalled")
    assert.equal(event.blocking, false)
  })
})

test("createDaemonEventHandler nudges only background owners", async (t) => {
  const logger = new Logger(false)

  await t.test("nudges background owner", async () => {
    const state = createPluginState()
    ownWorker(state)
    recordBackgroundWorker(state, "sess-1", "w1")
    const { client, calls } = createMockOpencodeClient()
    const handler = createDaemonEventHandler(state, logger, mockConfig, client)

    handler({ type: "worker.stalled", payload: { workerId: "w1", summary: "Worker stalled" } })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.sessionId, "sess-1")
    assert.match(calls[0]?.text ?? "", /^\[paseo:worker\.stalled\]/)
  })

  await t.test("does not nudge foreground owner but still inserts inbox", async () => {
    const state = createPluginState()
    ownWorker(state)
    const { client, calls } = createMockOpencodeClient()
    const handler = createDaemonEventHandler(state, logger, mockConfig, client)

    handler({ type: "worker.stalled", payload: { workerId: "w1", summary: "Worker stalled" } })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(state.inbox.size, 1)
    assert.equal(calls.length, 0)
  })

  await t.test("nudgeEnabled=false keeps inbox but disables nudge", async () => {
    const state = createPluginState()
    ownWorker(state)
    recordBackgroundWorker(state, "sess-1", "w1")
    const { client, calls } = createMockOpencodeClient()
    const handler = createDaemonEventHandler(state, logger, { ...mockConfig, nudgeEnabled: false }, client)

    handler({ type: "worker.stalled", payload: { workerId: "w1", summary: "Worker stalled" } })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(state.inbox.size, 1)
    assert.equal(calls.length, 0)
  })
})

function workerSummary(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: "w1",
    title: "w1",
    agent: "general",
    provider: "general",
    model: null,
    currentModeId: null,
    status: "running",
    cwd: "/tmp",
    labels: [],
    pendingPermissions: [],
    pendingPermissionIds: [],
    requiresAttention: false,
    attentionReason: null,
    runtimeInfo: null,
    persistence: null,
    unreadEventCount: 0,
    ...overrides,
  }
}

test("createEventHandler", async (t) => {
  const logger = new Logger(false)
  const mockTransport = {
    cancelWorker: async () => {},
  } as unknown as PaseoTransport

  await t.test("handles session.deleted by removing session", async () => {
    const state = createPluginState()
    const session = ownWorker(state, "sess-1")
    session.backgroundWorkerIds.add("w1")

    const handler = createEventHandler(state, mockTransport, logger, mockConfig)

    await handler({ event: { type: "session.deleted", properties: { info: { id: "sess-1" } } } as any })

    assert.equal(state.sessions.size, 0)
  })

  await t.test("session.deleted clears unread and pending state", async () => {
    const state = createPluginState()
    const session = ownWorker(state, "sess-1")

    insertInboxEvent(state, {
      id: "evt-1",
      kind: "agent.attention",
      resourceId: "w1",
      blocking: true,
      summary: "blocked",
      read: false,
      timestamp: Date.now(),
    })

    assert.equal(session.unreadEvents.size, 1)
    assert.equal(session.pendingPermissions.size, 1)

    const handler = createEventHandler(state, mockTransport, logger, mockConfig)
    await handler({ event: { type: "session.deleted", properties: { info: { id: "sess-1" } } } as any })

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
          if (workerId === "w-ephemeral-2") throw new Error("cancel failed")
        },
      } as PaseoTransport,
      logger,
      mockConfig,
    )

    await handler({ event: { type: "session.deleted", properties: { info: { id: "sess-1" } } } as any })

    assert.deepEqual(canceled, ["w-ephemeral-1", "w-ephemeral-2"])
    assert.equal(state.ephemeralWorkerRuns.size, 0)
    assert.equal(state.sessions.size, 0)
  })
})
