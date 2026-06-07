import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState, insertInboxEvent, markEventRead } from "../lib/state/state.js"
import type { AgentSummary, PaseoTransport } from "../lib/transport/types.js"
import type { WorkerSummary } from "../lib/state/types.js"
import { Logger } from "../lib/logger.js"
import {
  createWorkerArchiveTool,
  createWorkerCancelTool,
  createWorkerCreateTool,
  createWorkerInspectTool,
  createWorkerLaunchStatusTool,
  createWorkerListTool,
  createWorkerSendTool,
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
      lines: [],
      totalLines: 0,
    }),
    sendTerminalInput: () => {},
    killTerminal: async () => ({ id: "t", exitCode: null }),
    respondToPermission: async (opts) => ({
      workerId: opts.workerId,
      permissionId: opts.permissionId,
      behavior: opts.behavior,
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
    createWorker: async () => ({
      id: "w",
      provider: "test",
      cwd: "/tmp",
      model: null,
      status: "running" as const,
      title: null,
    }),
    runWorker: async () => ({
      id: "w-run",
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
    loopRun: async () => ({ requestId: "req", loop: null, error: null }),
    loopList: async () => ({ requestId: "req", loops: [], error: null }),
    loopInspect: async () => ({ requestId: "req", loop: null, error: null }),
    loopLogs: async () => ({ requestId: "req", loop: null, entries: [], nextCursor: null, error: null }),
    loopStop: async () => ({ requestId: "req", loop: null, error: null }),
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
  nudgeEnabled: true,
  workerStallThresholdMs: 120000,
  daemon: {
    host: "127.0.0.1",
    port: 6767,
    connectionTimeoutMs: 3000,
  },
  output: {
    maxInboxItems: 100,
    maxSummaryLength: 500,
  },
  agents: {},
  task: { enabled: false },
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
    backgroundWorkerIds: new Set([id]),
    unreadEvents: new Map(),
    pendingPermissions: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return worker
}

function mockContext(abortSignal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: abortSignal,
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

async function withPaseoAgentId<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PASEO_AGENT_ID
  if (value === undefined) {
    delete process.env.PASEO_AGENT_ID
  } else {
    process.env.PASEO_AGENT_ID = value
  }

  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.PASEO_AGENT_ID
    } else {
      process.env.PASEO_AGENT_ID = previous
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

test("paseo_worker_send", async (t) => {
  const logger = new Logger(false)

  await t.test("forwards to daemon even when worker is absent from local state", async () => {
    const state = createPluginState()
    let received: { workerId: string; message: string } | null = null
    const client = createMockTransport({
      sendWorkerMessage: async (workerId, message) => {
        received = { workerId, message }
      },
    })

    const result = await createWorkerSendTool(state, client, logger).execute(
      { workerId: "missing", message: "hello" },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(received, { workerId: "missing", message: "hello" })
    assert.equal(output.workerId, "missing")
    assert.equal(output.sent, 5)
  })
})

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
    const result = await toolDef.execute({ workerIds: ["w1", "w2"], waitFor: "any", timeout: 1000 }, mockContext())
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
    const result = await toolDef.execute({ workerIds: ["w1", "w2"], waitFor: "all", timeout: 1000 }, mockContext())
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
    const result = await toolDef.execute({ workerIds: ["w1", "w2"], waitFor: "all", timeout: 1 }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.timedOut, true)
    assert.deepEqual(output.pendingWorkerIds, ["w1", "w2"])
    assert.deepEqual(output.results, [])
  })

  await t.test("waits using daemon truth even when a worker is absent from local state", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      waitForWorker: async (workerId) => ({
        status: "idle",
        workerId,
        error: null,
        lastMessage: null,
        finalSnapshot: null,
      }),
    })

    const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
    const result = await toolDef.execute({ workerIds: ["w1", "missing"] }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(
      output.results.map((entry: { workerId: string }) => entry.workerId),
      ["w1", "missing"],
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
          type: "agent_permission_request",
          payload: { workerId, permissionId: "perm-1", request: { id: "perm-1", summary: "needs permission" } },
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
    assert.equal(output.nudgeEvent.kind, "permission.requested")
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

  await t.test("early exit on unread chat.mentioned event for owned worker", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    insertInboxEvent(state, {
      id: "evt-chat",
      kind: "chat.mentioned",
      resourceId: "w1",
      blocking: false,
      summary: 'Mentioned in room "ops" by manual: please review',
      read: false,
      timestamp: Date.now(),
    })

    const client = createMockTransport()
    const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
    const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.interruptedByNudge, true)
    assert.equal(output.nudgeEvent.kind, "chat.mentioned")
    assert.equal(output.nudgeEvent.workerId, "w1")
  })

  await t.test("unread background status nudge wins over same-slice wait completion", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    seedWorker(state, "w2")
    const client = createMockTransport({
      waitForWorker: async (workerId) => {
        insertInboxEvent(state, {
          id: "evt-status",
          kind: "agent.status",
          resourceId: "w2",
          blocking: false,
          summary: "Worker w2 is idle",
          read: false,
          timestamp: Date.now(),
          metadata: { status: "idle" },
        })
        return {
          status: "idle",
          workerId,
          error: null,
          lastMessage: "done",
          finalSnapshot: null,
        }
      },
    })

    const toolDef = createWorkerWaitTool(state, client, TEST_CONFIG, logger)
    const result = await toolDef.execute({ workerIds: ["w1"], timeout: 500 }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.interruptedByNudge, true)
    assert.equal(output.nudgeEvent.kind, "agent.status")
    assert.equal(output.nudgeEvent.workerId, "w2")
    assert.equal(output.results[0]?.workerId, "w1")
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
            type: "agent_permission_request",
            payload: {
              workerId: "w2",
              permissionId: "perm-1",
              request: {},
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

  await t.test("default cancel closes local status and keeps worker in state", async () => {
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
    assert.equal(state.workers.get("w1")!.status, "closed")
    assert.equal(state.workers.get("w1")!.rawStatus, "canceled")
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

  await t.test("forceKill marks removed worker inbox events read", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    insertInboxEvent(state, {
      id: "evt-kill",
      kind: "agent.attention",
      resourceId: "w1",
      blocking: true,
      summary: "needs approval",
      read: false,
      timestamp: Date.now(),
    })

    const toolDef = createWorkerCancelTool(state, createMockTransport(), logger)
    await toolDef.execute({ workerId: "w1", forceKill: true }, mockContext())

    assert.equal(state.inbox.has("evt-kill"), true)
    assert.equal(state.inbox.get("evt-kill")?.read, true)
    assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-kill"), false)
    assert.equal(state.sessions.get("sess-1")?.pendingPermissions.has("evt-kill"), false)
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

  await t.test("still cancels when worker is not in local state", async () => {
    const state = createPluginState()
    let cancelCalls = 0
    const client = createMockTransport({
      cancelWorker: async () => {
        cancelCalls += 1
      },
    })

    const result = await createWorkerCancelTool(state, client, logger).execute(
      { workerId: "nonexistent" },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(cancelCalls, 1)
    assert.equal(output.workerId, "nonexistent")
    assert.equal(output.action, "canceled")
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
      kind: "agent.attention",
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
    assert.equal(state.inbox.get("evt-1")?.read, true)
    assert.equal(output.workerId, "w1")
    assert.equal(output.alreadyRemovedUpstream, false)
    assert.equal(typeof output.archivedAt, "string")
  })

  await t.test("upstream not found still cleans local state", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    insertInboxEvent(state, {
      id: "evt-1",
      kind: "agent.status",
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
    assert.equal(state.inbox.get("evt-1")?.read, true)
    assert.equal(output.workerId, "w1")
    assert.equal(output.archivedAt, null)
    assert.equal(output.alreadyRemovedUpstream, true)
  })

  await t.test("still archives when worker is absent from local state", async () => {
    const state = createPluginState()
    let archiveCalls = 0
    const client = createMockTransport({
      archiveWorker: async (workerId) => {
        archiveCalls += 1
        return {
          workerId,
          archivedAt: "2026-01-01T00:00:00.000Z",
        }
      },
    })

    const result = await createWorkerArchiveTool(state, client, logger).execute({ workerId: "missing" }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(archiveCalls, 1)
    assert.equal(output.workerId, "missing")
    assert.equal(output.alreadyRemovedUpstream, false)
  })

  await t.test("archived workers can still be daemon-inspectable after leaving the active list", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "codex",
          cwd: "/repo",
          model: "gpt-4",
          status: "closed",
          title: "Archived Worker",
          labels: {} as Record<string, string>,
        },
        project: null,
      }),
    })

    await createWorkerArchiveTool(state, client, logger).execute({ workerId: "w1" }, mockContext())
    assert.equal(state.workers.has("w1"), false)

    const inspectResult = await createWorkerInspectTool(state, client, logger).execute(
      { workerId: "w1" },
      mockContext(),
    )
    const output = JSON.parse((inspectResult as { output: string }).output)

    assert.equal(output.worker.id, "w1")
    assert.equal(output.worker.source, "daemon")
    assert.equal(output.worker.title, "Archived Worker")
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
    await assert.rejects(() => toolDef.execute({ workerId: "w1" }, mockContext()), /daemon unavailable/)
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
    stale.status = "closed"
    seedWorker(state, "w-live")
    state.sessions.get("sess-1")?.createdWorkerIds.add("w-stale")
    insertInboxEvent(state, {
      id: "evt-stale",
      kind: "agent.attention",
      resourceId: "w-stale",
      blocking: true,
      summary: "stale worker event",
      read: false,
      timestamp: Date.now(),
    })

    const fetchedAgents: AgentSummary[] = [
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
        labels: { "opencodePaseo.chatRoom": "ops-room" },
        pendingPermissions: [],
      },
    ]

    const client = createMockTransport({
      fetchAgents: async () => fetchedAgents,
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
    assert.deepEqual(output.workers.map((worker: { id: string }) => worker.id).sort(), ["w-live", "w-new"])
    assert.equal(output.workers.find((worker: { id: string }) => worker.id === "w-new")?.chatRoom, "ops-room")
  })

  await t.test("failed refresh surfaces the daemon error and does not prune local workers", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      fetchAgents: async () => {
        throw new Error("fetch failed")
      },
    })

    const toolDef = createWorkerListTool(state, client, logger)
    await assert.rejects(() => toolDef.execute({}, mockContext()), /fetch failed/)

    assert.equal(state.workers.has("w1"), true)
  })

  await t.test("recalculates unread counts and exposes observed launch ids from raw labels", async () => {
    const state = createPluginState()
    seedWorker(state, "w-live")
    state.workers.get("w-live")!.unreadEventCount = 99
    state.inbox.set("evt-1", {
      id: "evt-1",
      kind: "agent.status",
      resourceId: "w-live",
      blocking: false,
      summary: "done",
      read: false,
      timestamp: Date.now(),
    })

    let observedLaunchId: string | undefined
    const client = createMockTransport({
      fetchAgents: async () => [
        {
          id: "w-live",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Live Worker",
          labels: { "opencodePaseo.launchId": "launch-123" },
          pendingPermissions: [],
        },
      ],
    })

    const toolDef = createWorkerListTool(state, client, logger, (_worker, launchId) => {
      observedLaunchId = launchId
    })
    const result = await toolDef.execute({}, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(observedLaunchId, "launch-123")
    assert.equal(state.workers.get("w-live")?.unreadEventCount, 1)
    assert.equal(output.workers[0]?.unreadEventCount, 1)
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
    const result = await toolDef.execute({ workerId: "w1", name: "New Name", labels: { env: "prod" } }, mockContext())

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

  await t.test("treats ordinary null optionals as omitted but preserves nested clear nulls", async () => {
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

    await createWorkerUpdateTool(state, client, logger).execute(
      {
        workerId: "w1",
        name: null,
        labels: null,
        settings: {
          modeId: null,
          model: null,
          thinkingOptionId: null,
        },
      },
      mockContext(),
    )

    assert.deepEqual(receivedOptions, {
      workerId: "w1",
      settings: {
        model: null,
        thinkingOptionId: null,
      },
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

    await t.test("returns queued receipt and defaults to build profile when no profile specified", async () => {
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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      const result = await toolDef.execute({}, mockContext())
      await flushAsyncWork()

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
    })

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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await toolDef.execute({ profile: "review" }, mockContext())
      await flushAsyncWork()

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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await toolDef.execute({ profile: "   " }, mockContext())
      await flushAsyncWork()

      assert.equal(receivedOptions.profile, "build")
      assert.equal(receivedOptions.modeId, "build")
      assert.equal(receivedOptions.provider, "opencode")
      assert.equal(receivedOptions.model, "openai/gpt-5.4")
    })

    await t.test("uses opencode provider and omits model for partial profile model metadata", async () => {
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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await toolDef.execute({ profile: "partial" }, mockContext())
      await flushAsyncWork()

      assert.equal(receivedOptions.profile, "partial")
      assert.equal(receivedOptions.modeId, "partial")
      assert.equal(receivedOptions.provider, "opencode")
      assert.equal(receivedOptions.model, undefined)
    })

    await t.test("throws clear error for unknown profile", async () => {
      const state = createPluginState()
      const client = createMockTransport()
      const opencode = mockOpencodeClient()
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await assert.rejects(
        () => toolDef.execute({ profile: "nonexistent" }, mockContext()),
        /Profile "nonexistent" not found\. Available profiles: build, review/,
      )
    })

    await t.test("passes initialPrompt and labels through", async () => {
      await withPaseoAgentId(undefined, async () => {
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
        const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

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
        await flushAsyncWork()

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(receivedOptions.initialPrompt, "Fix the bug")
        assert.deepEqual(receivedOptions.labels, {
          priority: "high",
          "opencodePaseo.launchId": output.launchId,
          "opencodePaseo.sessionId": "sess-1",
          "opencodePaseo.worktreeName": "repo-worktree",
        })
      })
    })

    await t.test("appends chat room instructions and persists reserved label", async () => {
      await withPaseoAgentId(undefined, async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        const client = createMockTransport({
          createWorker: async (opts) => {
            receivedOptions = opts
            return {
              id: "w-chat",
              provider: "opencode",
              cwd: "/tmp",
              model: null,
              status: "running" as const,
              title: null,
            }
          },
        })
        const opencode = mockOpencodeClient()
        const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

        const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
        const result = await toolDef.execute(
          {
            initialPrompt: "Solve the task.",
            chatRoom: "  room-alpha  ",
            labels: {
              priority: "high",
              "opencodePaseo.chatRoom": "wrong-room",
            },
          },
          mockContext(),
        )
        await flushAsyncWork()

        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.chatRoom, "room-alpha")
        assert.match(receivedOptions.initialPrompt, /^Solve the task\.\n\nPaseo chat coordination instructions:/)
        assert.match(receivedOptions.initialPrompt, /room-alpha/)
        assert.match(receivedOptions.initialPrompt, /paseo chat post/)
        assert.match(receivedOptions.initialPrompt, /PASEO_AGENT_ID/)
        assert.match(receivedOptions.initialPrompt, /@<worker-id>/)
        assert.deepEqual(receivedOptions.labels, {
          priority: "high",
          "opencodePaseo.chatRoom": "room-alpha",
          "opencodePaseo.launchId": output.launchId,
          "opencodePaseo.sessionId": "sess-1",
        })
      })
    })

    await t.test("ignores empty optional chatRoom and worktreeName", async () => {
      const state = createPluginState()
      let receivedOptions: any = null
      const client = createMockTransport({
        createWorker: async (opts) => {
          receivedOptions = opts
          return {
            id: "w-empty-options",
            provider: "opencode",
            cwd: "/tmp",
            model: null,
            status: "running" as const,
            title: null,
          }
        },
      })
      const opencode = mockOpencodeClient()
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await toolDef.execute({ chatRoom: "", worktreeName: "   ", cwd: "" }, mockContext())
      await flushAsyncWork()

      assert.equal(receivedOptions.cwd, "/tmp")
      assert.equal("chatRoom" in receivedOptions, false)
      assert.equal("worktreeName" in receivedOptions, false)
    })

    await t.test("treats null optional create args as omitted", async () => {
      const state = createPluginState()
      let receivedOptions: any = null
      const client = createMockTransport({
        createWorker: async (opts) => {
          receivedOptions = opts
          return {
            id: "w-null-options",
            provider: "opencode",
            cwd: "/tmp",
            model: null,
            status: "running" as const,
            title: null,
          }
        },
      })
      const opencode = mockOpencodeClient()
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      await createWorkerCreateTool(opencode, workerLaunchQueue, logger).execute(
        { chatRoom: null, worktreeName: null, cwd: null, profile: null, initialPrompt: null, labels: null },
        mockContext(),
      )
      await flushAsyncWork()

      assert.equal(receivedOptions.cwd, "/tmp")
      assert.equal(receivedOptions.profile, "build")
      assert.equal(receivedOptions.provider, "opencode")
      assert.equal(receivedOptions.model, "openai/gpt-5.4")
      assert.equal(receivedOptions.modeId, "build")
      assert.equal("chatRoom" in receivedOptions, false)
      assert.equal("worktreeName" in receivedOptions, false)
      assert.equal("initialPrompt" in receivedOptions, false)
    })

    await t.test("uses coordination block alone when no initial prompt exists", async () => {
      const state = createPluginState()
      let receivedOptions: any = null
      const client = createMockTransport({
        createWorker: async (opts) => {
          receivedOptions = opts
          return {
            id: "w-chat-only",
            provider: "opencode",
            cwd: "/tmp",
            model: null,
            status: "running" as const,
            title: null,
          }
        },
      })
      const opencode = mockOpencodeClient()
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      await toolDef.execute({ chatRoom: "room-beta" }, mockContext())
      await flushAsyncWork()

      assert.match(receivedOptions.initialPrompt, /^Paseo chat coordination instructions:/)
      assert.match(receivedOptions.initialPrompt, /room-beta/)
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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

      const toolDef = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
      const first = JSON.parse(((await toolDef.execute({}, mockContext())) as { output: string }).output)
      const second = JSON.parse(((await toolDef.execute({}, mockContext())) as { output: string }).output)

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
      const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

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
      "paseo_worker_launch_status returns queued, starting, created, and rollback-aware failed states",
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
          listWorktrees: async () => ({
            requestId: "req",
            worktrees: [],
            error: null,
          }),
        })
        const opencode = mockOpencodeClient()
        const workerLaunchQueue = createWorkerLaunchQueueController(state, client, opencode, logger)

        const createTool = createWorkerCreateTool(opencode, workerLaunchQueue, logger)
        const statusTool = createWorkerLaunchStatusTool(workerLaunchQueue, logger)

        const first = JSON.parse(((await createTool.execute({}, mockContext())) as { output: string }).output)
        const second = JSON.parse(
          ((await createTool.execute({ worktreeName: "feature/test" }, mockContext())) as { output: string }).output,
        )

        const queued = JSON.parse(
          (
            (await statusTool.execute({ launchId: second.launchId }, mockContext())) as {
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
            (await statusTool.execute({ launchId: second.launchId }, mockContext())) as {
              output: string
            }
          ).output,
        )
        assert.equal(failed.status, "failed")
        assert.match(failed.error, /daemon unavailable/)
        assert.deepEqual(failed.rollback, {
          attempted: false,
          outcome: "not_needed",
          message: "Worker launch failed. No new worktree was detected, so no cleanup is needed.",
        })

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

  await t.test("worker wait defaults survive null optional args", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      waitForWorker: async (workerId) => ({
        status: "idle",
        workerId,
        error: null,
        lastMessage: null,
        finalSnapshot: null,
      }),
    })

    const result = await createWorkerWaitTool(state, client, TEST_CONFIG, logger).execute(
      { workerIds: ["w1"], waitFor: null, timeout: null },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.waitFor, "all")
    assert.equal(output.timedOut, false)
  })

  await t.test("worker cancel treats null forceKill like omission", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    let cancelCalls = 0
    let killCalls = 0
    const client = createMockTransport({
      cancelWorker: async () => {
        cancelCalls += 1
      },
      killWorker: async () => {
        killCalls += 1
      },
    })

    await createWorkerCancelTool(state, client, logger).execute({ workerId: "w1", forceKill: null }, mockContext())

    assert.equal(cancelCalls, 1)
    assert.equal(killCalls, 0)
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

  await t.test("still updates when worker is absent from local state", async () => {
    const state = createPluginState()
    let receivedWorkerId: string | null = null
    const client = createMockTransport({
      updateWorker: async (opts) => {
        receivedWorkerId = opts.workerId
        return {
          workerId: opts.workerId,
          updated: false,
          metadataUpdated: false,
          settingsUpdated: false,
          errors: [],
        }
      },
    })

    const result = await createWorkerUpdateTool(state, client, logger).execute(
      { workerId: "nonexistent" },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(receivedWorkerId, "nonexistent")
    assert.equal(output.workerId, "nonexistent")
  })
})

// ─── Inspect Tool Tests ──────────────────────────────────────────────────────

test("paseo_worker_inspect", async (t) => {
  const logger = new Logger(false)

  await t.test("treats null activity options as omitted", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    let activityCalls = 0
    const client = createMockTransport({
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: {},
        },
        project: null,
      }),
      fetchWorkerActivity: async () => {
        activityCalls += 1
        return { workerId: "w1", activity: null }
      },
    })

    await createWorkerInspectTool(state, client, logger).execute(
      { workerId: "w1", includeActivity: null, activityLimit: null },
      mockContext(),
    )

    assert.equal(activityCalls, 0)
  })

  await t.test("returns snapshot without activity by default", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    let activityCalled = false
    const client = createMockTransport({
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: { "opencodePaseo.chatRoom": "ops-room" },
        },
        project: null,
      }),
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
    assert.equal(output.worker.source, "daemon")
    assert.equal(output.worker.rawStatus, "running")
    assert.equal(output.worker.chatRoom, "ops-room")
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
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: {},
        },
        project: null,
      }),
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
    const result = await toolDef.execute({ workerId: "w1", includeActivity: true }, mockContext())

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
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: {},
        },
        project: null,
      }),
      fetchWorkerActivity: async () => ({
        workerId: "w1",
        activity: null,
      }),
    })

    const toolDef = createWorkerInspectTool(state, client, logger)
    const result = await toolDef.execute({ workerId: "w1", includeActivity: true }, mockContext())

    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.activity, null)
    assert.equal(output.progress.activityState, "quiet")
  })

  await t.test("passes activityLimit to transport", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    let receivedLimit: number | undefined
    const client = createMockTransport({
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: {},
        },
        project: null,
      }),
      fetchWorkerActivity: async (opts) => {
        receivedLimit = opts.limit
        return { workerId: opts.workerId, activity: { entries: [], hasMore: false } }
      },
    })

    const toolDef = createWorkerInspectTool(state, client, logger)
    await toolDef.execute({ workerId: "w1", includeActivity: true, activityLimit: 10 }, mockContext())

    assert.equal(receivedLimit, 10)
  })

  await t.test("uses fresh daemon data and exposes raw status plus attention fields", async () => {
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
    assert.equal(output.worker.status, "initializing")
    assert.equal(output.worker.rawStatus, "initializing")
    assert.equal(output.worker.source, "daemon")
    assert.equal(output.attention.requiresAttention, true)
    assert.equal(output.attention.attentionReason, "permission")
    assert.equal(output.attention.pendingPermissionCount, 1)
    assert.equal(output.attention.blockingAction, "paseo_permission_respond")
    assert.equal(output.project, undefined)
  })

  await t.test("distinguishes quiet from active running workers", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      fetchWorker: async () => ({
        agent: {
          id: "w1",
          provider: "test",
          cwd: "/tmp",
          model: null,
          status: "running",
          title: "Worker w1",
          labels: {},
        },
        project: null,
      }),
      fetchWorkerActivity: async () => ({
        workerId: "w1",
        activity: { entries: [], hasMore: false },
      }),
    })

    const toolDef = createWorkerInspectTool(state, client, logger)
    const result = await toolDef.execute({ workerId: "w1", includeActivity: true }, mockContext())

    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.progress.activityState, "quiet")
    assert.match(output.progress.summary, /running but has no recent projected activity/)
  })

  await t.test("fails when daemon fetch returns null", async () => {
    const state = createPluginState()
    seedWorker(state, "w1")
    const client = createMockTransport({
      fetchWorker: async () => null,
    })

    const toolDef = createWorkerInspectTool(state, client, logger)
    await assert.rejects(() => toolDef.execute({ workerId: "w1" }, mockContext()), /not found/)
  })

  await t.test("throws when worker not found anywhere", async () => {
    const state = createPluginState()
    const client = createMockTransport()

    const toolDef = createWorkerInspectTool(state, client, logger)
    await assert.rejects(() => toolDef.execute({ workerId: "nonexistent" }, mockContext()), /not found/)
  })
})
