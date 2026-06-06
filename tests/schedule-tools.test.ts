import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import { createScheduleCreateTool, createScheduleRunOnceTool, createScheduleUpdateTool } from "../lib/tools/schedule.js"
import type { OpencodeClient } from "../lib/profile.js"
import type { ToolContext } from "@opencode-ai/plugin/tool"

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
  return {
    isConnected: () => true,
    connect: async () => {},
    close: async () => {},
    getServerInfo: () => null,
    fetchAgents: async () => [],
    listTerminals: async () => [],
    getStatus: async () => ({}),
    getProvidersSnapshot: async () => [{ id: "opencode", provider: "opencode" }],
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
    waitForChatMessages: async () => ({ requestId: "req", messages: [], timedOut: true, error: null }),
    createWorker: async () => ({
      id: "w",
      provider: "opencode",
      cwd: "/tmp",
      model: null,
      status: "running" as const,
      title: null,
    }),
    runWorker: async () => ({
      id: "w-run",
      provider: "opencode",
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

function mockOpencodeClient(
  agents: Array<Record<string, unknown>> = [
    {
      name: "build",
      description: "Build agent",
      mode: "primary",
      model: { providerID: "openai", modelID: "gpt-5.4" },
    },
    {
      name: "partial",
      description: "Partial agent",
      mode: "primary",
      model: { providerID: "openai", modelID: null },
    },
  ],
): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: agents }),
    },
  } as unknown as OpencodeClient
}

function mockContext(): ToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
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

test("paseo_schedule_create", async (t) => {
  const logger = new Logger(false)

  await t.test("requires profile for new-agent target", async () => {
    const state = createPluginState()
    const client = createMockTransport()
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await assert.rejects(
      () =>
        toolDef.execute(
          {
            prompt: "Run nightly",
            cadenceType: "every",
            everyMs: 1000,
            targetType: "new-agent",
          },
          mockContext(),
        ),
      /profile is required for 'new-agent' target/,
    )
  })

  await t.test("resolves profile to opencode provider and joined model", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleCreate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await toolDef.execute(
      {
        prompt: "Run nightly",
        cadenceType: "every",
        everyMs: 1000,
        targetType: "new-agent",
        profile: "build",
      },
      mockContext(),
    )

    assert.equal(receivedOptions.target.type, "new-agent")
    assert.deepEqual(receivedOptions.target.config, {
      provider: "opencode",
      cwd: "/tmp",
      model: "openai/gpt-5.4",
      modeId: "build",
    })
    assert.equal("labels" in receivedOptions.target.config, false)
  })

  await t.test("does not send unsupported parent-label fields for new-agent schedules", async () => {
    await withPaseoAgentId("parent-schedule", async () => {
      const state = createPluginState()
      let receivedOptions: any = null
      const client = createMockTransport({
        scheduleCreate: async (opts) => {
          receivedOptions = opts
          return { requestId: "req", schedule: null, error: null }
        },
      })
      const opencode = mockOpencodeClient()

      await createScheduleCreateTool(state, client, opencode, logger).execute(
        {
          prompt: "Run nightly",
          cadenceType: "every",
          everyMs: 1000,
          targetType: "new-agent",
          profile: "build",
        },
        mockContext(),
      )

      assert.equal("labels" in receivedOptions.target.config, false)
      assert.equal("paseo.parent-agent-id" in receivedOptions.target.config, false)
    })
  })

  await t.test("omits model when profile model metadata is partial", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleCreate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await toolDef.execute(
      {
        prompt: "Run nightly",
        cadenceType: "every",
        everyMs: 1000,
        targetType: "new-agent",
        profile: "partial",
      },
      mockContext(),
    )

    assert.deepEqual(receivedOptions.target.config, {
      provider: "opencode",
      cwd: "/tmp",
      modeId: "partial",
    })
  })

  await t.test("rejects profile for non-new-agent targets", async () => {
    const state = createPluginState()
    const client = createMockTransport()
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await assert.rejects(
      () =>
        toolDef.execute(
          {
            prompt: "Run nightly",
            cadenceType: "every",
            everyMs: 1000,
            targetType: "agent",
            agentId: "a1",
            profile: "build",
          },
          mockContext(),
        ),
      /profile is only supported for target type 'new-agent'/,
    )
  })

  await t.test("creates agent target schedules without exposing self target semantics", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleCreate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await toolDef.execute(
      {
        prompt: "Run nightly",
        cadenceType: "every",
        everyMs: 1000,
        targetType: "agent",
        agentId: "a1",
      },
      mockContext(),
    )

    assert.deepEqual(receivedOptions.target, { type: "agent", agentId: "a1" })
  })

  await t.test("errors when resolved provider is unavailable", async () => {
    const state = createPluginState()
    const client = createMockTransport({
      getProvidersSnapshot: async () => [{ id: "claude", provider: "claude" }],
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await assert.rejects(
      () =>
        toolDef.execute(
          {
            prompt: "Run nightly",
            cadenceType: "every",
            everyMs: 1000,
            targetType: "new-agent",
            profile: "build",
          },
          mockContext(),
        ),
      /Provider "opencode" not found in daemon provider snapshot/,
    )
  })

  await t.test("throws clear error for unknown profile", async () => {
    const state = createPluginState()
    const client = createMockTransport()
    const opencode = mockOpencodeClient([{ name: "build", mode: "primary" }])

    const toolDef = createScheduleCreateTool(state, client, opencode, logger)
    await assert.rejects(
      () =>
        toolDef.execute(
          {
            prompt: "Run nightly",
            cadenceType: "every",
            everyMs: 1000,
            targetType: "new-agent",
            profile: "missing",
          },
          mockContext(),
        ),
      /Profile "missing" not found\. Available profiles: build/,
    )
  })
})

test("paseo_schedule_update", async (t) => {
  const logger = new Logger(false)

  await t.test("resolves profile into newAgentConfig", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleUpdate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
    await toolDef.execute({ id: "sched-1", profile: "build" }, mockContext())

    assert.deepEqual(receivedOptions.newAgentConfig, {
      provider: "opencode",
      model: "openai/gpt-5.4",
      modeId: "build",
    })
    assert.equal("labels" in receivedOptions.newAgentConfig, false)
  })

  await t.test("supports cwd-only new-agent updates", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleUpdate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
    await toolDef.execute({ id: "sched-2", cwd: "/repo" }, mockContext())

    assert.deepEqual(receivedOptions.newAgentConfig, { cwd: "/repo" })
  })

  await t.test("resolves profile using provided cwd when profile and cwd are both set", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    let snapshotCwd: string | undefined
    let profileDirectory: string | undefined
    const client = createMockTransport({
      getProvidersSnapshot: async (cwd) => {
        snapshotCwd = cwd
        return [{ id: "opencode", provider: "opencode" }]
      },
      scheduleUpdate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = {
      app: {
        agents: async ({ query }: { query?: { directory?: string } }) => {
          profileDirectory = query?.directory
          return {
            data: [
              {
                name: "build",
                description: "Build agent",
                mode: "primary",
                model: { providerID: "openai", modelID: "gpt-5.4" },
              },
            ],
          }
        },
      },
    } as unknown as OpencodeClient

    const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
    await toolDef.execute({ id: "sched-2b", profile: "build", cwd: "/repo" }, mockContext())

    assert.equal(profileDirectory, "/repo")
    assert.equal(snapshotCwd, "/repo")
    assert.deepEqual(receivedOptions.newAgentConfig, {
      provider: "opencode",
      model: "openai/gpt-5.4",
      modeId: "build",
      cwd: "/repo",
    })
  })

  await t.test("omits wrapper-default empty strings and zeroes", async () => {
    const state = createPluginState()
    let receivedOptions: any = null
    const client = createMockTransport({
      scheduleUpdate: async (opts) => {
        receivedOptions = opts
        return { requestId: "req", schedule: null, error: null }
      },
    })
    const opencode = mockOpencodeClient()

    const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
    await toolDef.execute(
      {
        id: "sched-3",
        name: "Renamed",
        prompt: "",
        everyMs: 0,
        maxRuns: 0,
        cronExpression: "   ",
        timezone: "",
        profile: "   ",
        cwd: "",
        expiresAt: "",
      },
      mockContext(),
    )

    assert.deepEqual(receivedOptions, { id: "sched-3", name: "Renamed" })
  })

  await t.test("throws clear error for unknown profile", async () => {
    const state = createPluginState()
    const client = createMockTransport()
    const opencode = mockOpencodeClient([{ name: "build", mode: "primary" }])

    const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
    await assert.rejects(
      () => toolDef.execute({ id: "sched-4", profile: "missing" }, mockContext()),
      /Profile "missing" not found\. Available profiles: build/,
    )
  })
})

test("paseo_schedule_run_once", async (t) => {
  const logger = new Logger(false)

  await t.test("returns async dispatch acknowledgment when daemon response times out", async () => {
    const state = createPluginState()
    const client = createMockTransport({
      scheduleRunOnce: async () => ({
        requestId: "timeout-req",
        schedule: null,
        error: null,
        dispatched: true,
        async: true,
        warning: "Timeout waiting for message (10000ms). Use paseo_schedule_logs.",
        nextStep: "paseo_schedule_logs",
      }),
    })

    const toolDef = createScheduleRunOnceTool(state, client, logger)
    const result = await toolDef.execute({ id: "sched-timeout" }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.dispatched, true)
    assert.equal(output.async, true)
    assert.equal(output.nextStep, "paseo_schedule_logs")
    assert.match(output.warning, /Timeout waiting for message \(10000ms\)/)
  })

  await t.test("surfaces non-timeout transport errors", async () => {
    const state = createPluginState()
    const client = createMockTransport({
      scheduleRunOnce: async () => {
        throw new Error("schedule not found")
      },
    })

    const toolDef = createScheduleRunOnceTool(state, client, logger)
    await assert.rejects(() => toolDef.execute({ id: "missing" }, mockContext()), /schedule not found/)
  })
})
