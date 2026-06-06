import test from "node:test"
import assert from "node:assert/strict"
import { createWorkerStallMonitor } from "../lib/worker-stall-monitor.js"
import { Logger } from "../lib/logger.js"
import { createPluginState, getOrCreateSession, insertInboxEvent } from "../lib/state/state.js"
import type { PluginConfig } from "../lib/config.js"
import type { DaemonEvent } from "../lib/transport/types.js"
import type { WorkerSummary } from "../lib/state/types.js"

type IntervalCallback = () => void

const TEST_CONFIG: PluginConfig = {
  enabled: true,
  debug: false,
  daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
  output: { maxInboxItems: 100, maxSummaryLength: 500 },
  notifications: { enabled: true, blockingOnly: false, stalledThresholdMs: 10000 },
  agents: {},
  task: { enabled: false },
}

function makeWorkerSummary(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  const timestamp = new Date(Date.now() - 20_000).toISOString()
  const defaults: WorkerSummary = {
    id: "w1",
    title: "Worker 1",
    agent: "test",
    status: "running",
    rawStatus: "running",
    cwd: "/tmp",
    provider: "test",
    model: null,
    currentModeId: null,
    labels: [],
    pendingPermissions: [],
    pendingPermissionIds: [],
    requiresAttention: false,
    attentionReason: null,
    runtimeInfo: null,
    persistence: null,
    unreadEventCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  return { ...defaults, ...overrides }
}

function seedWorker(state: ReturnType<typeof createPluginState>, partial: Partial<WorkerSummary> = {}) {
  const worker = makeWorkerSummary(partial)
  state.workers.set(worker.id, worker)
  const session = getOrCreateSession(state, "sess-1", "/tmp")
  session.createdWorkerIds.add(worker.id)
  return worker
}

test("createWorkerStallMonitor", async (t) => {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval

  t.afterEach(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  })

  await t.test("emits one worker.stalled event per inactivity episode", () => {
    const state = createPluginState()
    seedWorker(state)
    const emitted: DaemonEvent[] = []
    let sweep: (() => void) | undefined
    globalThis.setInterval = (fn: IntervalCallback) => {
      sweep = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }
    globalThis.clearInterval = () => {}

    const monitor = createWorkerStallMonitor(state, new Logger(false), TEST_CONFIG, (event) => emitted.push(event))
    monitor.seedFromWorkers()
    monitor.start()

    assert.ok(sweep)
    sweep()
    sweep()

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.type, "worker.stalled")
    monitor.stop()
  })

  await t.test("activity clears stall and resolves unread stall events", () => {
    const state = createPluginState()
    const worker = seedWorker(state)
    const emitted: DaemonEvent[] = []
    let sweep: (() => void) | undefined
    globalThis.setInterval = (fn: IntervalCallback) => {
      sweep = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }
    globalThis.clearInterval = () => {}

    const monitor = createWorkerStallMonitor(state, new Logger(false), TEST_CONFIG, (event) => {
      emitted.push(event)
      if (event.type === "worker.stalled") {
        insertInboxEvent(state, {
          id: "evt-stalled",
          kind: "worker.stalled",
          resourceId: worker.id,
          blocking: false,
          summary: String(event.payload.summary ?? "stalled"),
          read: false,
          timestamp: Date.now(),
        })
      }
    })
    monitor.seedFromWorkers()
    monitor.start()
    sweep!()

    monitor.observeEvent({
      type: "worker.activity",
      payload: {
        workerId: worker.id,
        timestamp: new Date().toISOString(),
        subtype: "turn_completed",
      },
    })

    assert.equal(state.inbox.get("evt-stalled")?.read, true)
    sweep!()
    assert.equal(emitted.length, 1)
    monitor.stop()
  })

  await t.test("ineligible workers do not stall", () => {
    const state = createPluginState()
    seedWorker(state, { rawStatus: "idle" })
    const emitted: DaemonEvent[] = []
    let sweep: (() => void) | undefined
    globalThis.setInterval = (fn: IntervalCallback) => {
      sweep = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }
    globalThis.clearInterval = () => {}

    const monitor = createWorkerStallMonitor(state, new Logger(false), TEST_CONFIG, (event) => emitted.push(event))
    monitor.seedFromWorkers()
    monitor.start()
    sweep!()

    assert.equal(emitted.length, 0)
    monitor.stop()
  })
})
