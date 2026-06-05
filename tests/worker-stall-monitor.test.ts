import test from "node:test"
import assert from "node:assert/strict"
import { createWorkerStallMonitor } from "../lib/worker-stall-monitor.js"
import { Logger } from "../lib/logger.js"
import { createPluginState, getOrCreateSession, insertInboxEvent } from "../lib/state/state.js"
import type { PluginConfig } from "../lib/config.js"
import type { DaemonEvent } from "../lib/transport/types.js"
import type { WorkerSummary } from "../lib/state/types.js"

const TEST_CONFIG: PluginConfig = {
  enabled: true,
  debug: false,
  daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
  output: { maxInboxItems: 100, maxSummaryLength: 500 },
  notifications: { enabled: true, blockingOnly: false, stalledThresholdMs: 10000 },
  agents: {},
}

function seedWorker(state: ReturnType<typeof createPluginState>, partial: Partial<WorkerSummary> = {}) {
  const worker: WorkerSummary = {
    id: partial.id ?? "w1",
    title: partial.title ?? "Worker 1",
    agent: partial.agent ?? "test",
    status: partial.status ?? "running",
    rawStatus: partial.rawStatus ?? "running",
    cwd: partial.cwd ?? "/tmp",
    provider: partial.provider ?? "test",
    model: partial.model ?? null,
    currentModeId: partial.currentModeId ?? null,
    labels: partial.labels ?? [],
    worktreePath: partial.worktreePath,
    branchName: partial.branchName,
    pendingPermissions: partial.pendingPermissions ?? [],
    pendingPermissionIds: partial.pendingPermissionIds ?? [],
    requiresAttention: partial.requiresAttention ?? false,
    attentionReason: partial.attentionReason ?? null,
    runtimeInfo: partial.runtimeInfo ?? null,
    persistence: partial.persistence ?? null,
    unreadEventCount: partial.unreadEventCount ?? 0,
    createdAt: partial.createdAt ?? new Date(Date.now() - 20_000).toISOString(),
    updatedAt: partial.updatedAt ?? new Date(Date.now() - 20_000).toISOString(),
  }
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
    globalThis.setInterval = ((fn: TimerHandler) => {
      sweep = fn as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    const monitor = createWorkerStallMonitor(state, new Logger(false), TEST_CONFIG, (event) => emitted.push(event))
    monitor.seedFromWorkers()
    monitor.start()

    assert.ok(sweep)
    sweep!()
    sweep!()

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.type, "worker.stalled")
    monitor.stop()
  })

  await t.test("activity clears stall and resolves unread stall events", () => {
    const state = createPluginState()
    const worker = seedWorker(state)
    const emitted: DaemonEvent[] = []
    let sweep: (() => void) | undefined
    globalThis.setInterval = ((fn: TimerHandler) => {
      sweep = fn as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

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
    globalThis.setInterval = ((fn: TimerHandler) => {
      sweep = fn as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    const monitor = createWorkerStallMonitor(state, new Logger(false), TEST_CONFIG, (event) => emitted.push(event))
    monitor.seedFromWorkers()
    monitor.start()
    sweep!()

    assert.equal(emitted.length, 0)
    monitor.stop()
  })
})
