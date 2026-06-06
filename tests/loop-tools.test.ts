import assert from "node:assert/strict"
import test from "node:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { Logger } from "../lib/logger.js"
import {
  createLoopInspectTool,
  createLoopListTool,
  createLoopLogsTool,
  createLoopRunTool,
  createLoopStopTool,
} from "../lib/tools/loop.js"
import type { PaseoTransport } from "../lib/transport/types.js"

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
      timedOut: false,
      error: null,
    }),
    createWorker: async () => ({
      id: "w",
      provider: "opencode",
      cwd: "/tmp",
      model: null,
      status: "running",
      title: null,
    }),
    runWorker: async () => ({
      id: "w",
      provider: "opencode",
      cwd: "/tmp",
      model: null,
      status: "running",
      title: null,
    }),
    sendWorkerMessage: async () => {},
    waitForWorker: async () => ({
      status: "idle",
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
      metadataUpdated: true,
      settingsUpdated: true,
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
    loopLogs: async () => ({
      requestId: "req",
      loop: null,
      entries: [],
      nextCursor: null,
      error: null,
    }),
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

function mockContext(directory = "/context-dir"): ToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
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

test("paseo_loop_run", async (t) => {
  const logger = new Logger(false)

  await t.test("forwards normalized args", async () => {
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      loopRun: async (options) => {
        received = options as unknown as Record<string, unknown>
        return {
          requestId: "req",
          loop: { id: "loop-1", iterations: [] },
          error: null,
        }
      },
    })

    const result = await createLoopRunTool(client, logger).execute(
      {
        prompt: "  ship it  ",
        cwd: "  /repo  ",
        provider: "  openai  ",
        model: "  gpt-5.4  ",
        modeId: "  build  ",
        verifierProvider: "  verifier-provider  ",
        verifierModel: "  verifier-model  ",
        verifierModeId: "  verifier-mode  ",
        verifyPrompt: "  verify this  ",
        verifyChecks: ["  pnpm test  ", "   ", "  pnpm build  "],
        name: "  loop name  ",
        sleepMs: 500,
        maxIterations: 3,
        maxTimeMs: 1000,
      },
      mockContext(),
    )

    assert.deepEqual(received, {
      prompt: "ship it",
      cwd: "/repo",
      provider: "openai",
      model: "gpt-5.4",
      modeId: "build",
      verifierProvider: "verifier-provider",
      verifierModel: "verifier-model",
      verifierModeId: "verifier-mode",
      verifyPrompt: "verify this",
      verifyChecks: ["pnpm test", "pnpm build"],
      name: "loop name",
      sleepMs: 500,
      maxIterations: 3,
      maxTimeMs: 1000,
    })
    assert.equal(typeof (result as { output: string }).output, "string")
  })

  await t.test("does not send unsupported parent-label fields even when PASEO_AGENT_ID is set", async () => {
    await withPaseoAgentId("parent-loop", async () => {
      let received: Record<string, unknown> | undefined
      const client = createMockTransport({
        loopRun: async (options) => {
          received = options as unknown as Record<string, unknown>
          return {
            requestId: "req",
            loop: { id: "loop-1", iterations: [] },
            error: null,
          }
        },
      })

      await createLoopRunTool(client, logger).execute(
        {
          prompt: "loop",
          verifyPrompt: "verify",
          maxIterations: 1,
        },
        mockContext(),
      )

      assert.equal("labels" in (received ?? {}), false)
      assert.equal("paseo.parent-agent-id" in (received ?? {}), false)
    })
  })

  await t.test("defaults cwd from tool context", async () => {
    let receivedCwd: string | undefined
    const client = createMockTransport({
      loopRun: async (options) => {
        receivedCwd = options.cwd
        return { requestId: "req", loop: { id: "loop-1", iterations: [] }, error: null }
      },
    })

    await createLoopRunTool(client, logger).execute(
      {
        prompt: "loop",
        verifyPrompt: "verify",
        maxIterations: 1,
      },
      mockContext("/from-context"),
    )

    assert.equal(receivedCwd, "/from-context")
  })

  await t.test("treats null optional args as omitted", async () => {
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      loopRun: async (options) => {
        received = options as unknown as Record<string, unknown>
        return {
          requestId: "req",
          loop: { id: "loop-1", iterations: [] },
          error: null,
        }
      },
    })

    await createLoopRunTool(client, logger).execute(
      {
        prompt: "loop",
        cwd: null,
        provider: null,
        model: null,
        modeId: null,
        verifierProvider: null,
        verifierModel: null,
        verifierModeId: null,
        verifyPrompt: null,
        verifyChecks: ["pnpm test"],
        name: null,
        sleepMs: null,
        maxIterations: 1,
        maxTimeMs: null,
      },
      mockContext("/ctx"),
    )

    assert.deepEqual(received, {
      prompt: "loop",
      cwd: "/ctx",
      verifyChecks: ["pnpm test"],
      maxIterations: 1,
    })
  })

  await t.test("rejects missing verification mechanisms", async () => {
    const client = createMockTransport()
    await assert.rejects(
      () =>
        createLoopRunTool(client, logger).execute(
          {
            prompt: "loop",
            maxIterations: 1,
          },
          mockContext(),
        ),
      /at least one verification mechanism is required: verifyPrompt or verifyChecks/,
    )
  })

  await t.test("rejects missing stop bounds", async () => {
    const client = createMockTransport()
    await assert.rejects(
      () =>
        createLoopRunTool(client, logger).execute(
          {
            prompt: "loop",
            verifyPrompt: "verify",
          },
          mockContext(),
        ),
      /at least one stop bound is required: maxIterations or maxTimeMs/,
    )
  })

  await t.test("rejects empty prompt", async () => {
    const client = createMockTransport()
    await assert.rejects(
      () =>
        createLoopRunTool(client, logger).execute(
          {
            prompt: "   ",
            verifyPrompt: "verify",
            maxIterations: 1,
          },
          mockContext(),
        ),
      /prompt must not be empty/,
    )
  })

  await t.test("rejects empty verify prompt", async () => {
    const client = createMockTransport()
    await assert.rejects(
      () =>
        createLoopRunTool(client, logger).execute(
          {
            prompt: "loop",
            verifyPrompt: "   ",
            maxIterations: 1,
          },
          mockContext(),
        ),
      /verifyPrompt must not be empty/,
    )
  })

  await t.test("rejects blank verify checks", async () => {
    const client = createMockTransport()
    await assert.rejects(
      () =>
        createLoopRunTool(client, logger).execute(
          {
            prompt: "loop",
            verifyPrompt: "verify",
            verifyChecks: ["   ", ""],
            maxIterations: 1,
          },
          mockContext(),
        ),
      /verifyChecks must contain at least one non-empty command/,
    )
  })
})

test("paseo_loop_list returns transport output", async () => {
  const logger = new Logger(false)
  const client = createMockTransport({
    loopList: async () => ({
      requestId: "req",
      loops: [{ id: "loop-1", status: "running" }],
      error: null,
    }),
  })

  const result = await createLoopListTool(client, logger).execute({}, mockContext())
  assert.deepEqual(JSON.parse((result as { output: string }).output), {
    requestId: "req",
    loops: [{ id: "loop-1", status: "running" }],
    error: null,
  })
})

test("paseo_loop_inspect forwards id", async () => {
  const logger = new Logger(false)
  let receivedId: string | undefined
  const client = createMockTransport({
    loopInspect: async (options) => {
      receivedId = options.id
      return { requestId: "req", loop: null, error: null }
    },
  })

  await createLoopInspectTool(client, logger).execute({ id: "  loop-1  " }, mockContext())
  assert.equal(receivedId, "loop-1")
})

test("paseo_loop_logs forwards id and afterSeq", async () => {
  const logger = new Logger(false)
  let received: Record<string, unknown> | undefined
  const client = createMockTransport({
    loopLogs: async (options) => {
      received = options as unknown as Record<string, unknown>
      return { requestId: "req", loop: null, entries: [], nextCursor: 12, error: null }
    },
  })

  await createLoopLogsTool(client, logger).execute({ id: "  loop-1  ", afterSeq: 11 }, mockContext())
  assert.deepEqual(received, { id: "loop-1", afterSeq: 11 })
})

test("paseo_loop_stop forwards id", async () => {
  const logger = new Logger(false)
  let receivedId: string | undefined
  const client = createMockTransport({
    loopStop: async (options) => {
      receivedId = options.id
      return { requestId: "req", loop: null, error: null }
    },
  })

  await createLoopStopTool(client, logger).execute({ id: "  loop-1  " }, mockContext())
  assert.equal(receivedId, "loop-1")
})
