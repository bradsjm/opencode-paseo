import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import {
  createTerminalCaptureTool,
  createTerminalCreateTool,
  createTerminalKillTool,
  createTerminalListTool,
  createTerminalSendInputTool,
  createTerminalSendLinesTool,
} from "../lib/tools/terminal.js"

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
    waitForChatMessages: async () => ({ requestId: "req", messages: [], timedOut: true, error: null }),
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

// ─── Send Input Tool Tests ──────────────────────────────────────────────────

test("paseo_terminal_send_input", async (t) => {
  const logger = new Logger(false)

  await t.test("forwards exact input string unchanged to transport", async () => {
    const state = createPluginState()
    let receivedTerminalId: string | undefined
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (terminalId, input) => {
        receivedTerminalId = terminalId
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendInputTool(state, client, logger)
    const result = await toolDef.execute({ terminalId: "t1", input: "ls -la\n" }, mockContext())

    assert.equal(receivedTerminalId, "t1")
    assert.equal(receivedInput, "ls -la\n")
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.terminalId, "t1")
    assert.equal(output.sent, 7)
  })

  await t.test("sends raw input with no escape-sequence interpretation", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendInputTool(state, client, logger)
    // Send literal backslash-n characters (not an actual newline)
    await toolDef.execute({ terminalId: "t1", input: "echo hello\\nworld" }, mockContext())

    assert.equal(receivedInput, "echo hello\\nworld")
  })

  await t.test("handles empty input string", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendInputTool(state, client, logger)
    const result = await toolDef.execute({ terminalId: "t1", input: "" }, mockContext())

    assert.equal(receivedInput, "")
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.sent, 0)
  })

  await t.test("sends special characters verbatim", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendInputTool(state, client, logger)
    const specialInput = "\t\x03\x1b[A"
    await toolDef.execute({ terminalId: "t1", input: specialInput }, mockContext())

    assert.equal(receivedInput, specialInput)
  })

  await t.test("surfaces synchronous transport throws", async () => {
    const state = createPluginState()
    const client = createMockTransport({
      sendTerminalInput: () => {
        throw new Error("send failed")
      },
    })

    const toolDef = createTerminalSendInputTool(state, client, logger)
    await assert.rejects(() => toolDef.execute({ terminalId: "t1", input: "pwd\n" }, mockContext()), /send failed/)
  })
})

// ─── Send Lines Tool Tests ──────────────────────────────────────────────────

test("paseo_terminal_send_lines", async (t) => {
  const logger = new Logger(false)

  await t.test("joins lines with newlines and appends trailing newline", async () => {
    const state = createPluginState()
    let receivedTerminalId: string | undefined
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (terminalId, input) => {
        receivedTerminalId = terminalId
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendLinesTool(state, client, logger)
    const result = await toolDef.execute(
      {
        terminalId: "t1",
        lines: ["echo hello", "echo world"],
      },
      mockContext(),
    )

    assert.equal(receivedTerminalId, "t1")
    assert.equal(receivedInput, "echo hello\necho world\n")
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.terminalId, "t1")
    assert.equal(output.lineCount, 2)
    assert.equal(output.sent, 22)
  })

  await t.test("handles single line", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendLinesTool(state, client, logger)
    const result = await toolDef.execute({ terminalId: "t1", lines: ["ls -la"] }, mockContext())

    assert.equal(receivedInput, "ls -la\n")
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.lineCount, 1)
    assert.equal(output.sent, 7)
  })

  await t.test("preserves empty-string lines", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendLinesTool(state, client, logger)
    await toolDef.execute({ terminalId: "t1", lines: ["echo a", "", "echo b"] }, mockContext())

    assert.equal(receivedInput, "echo a\n\necho b\n")
  })

  await t.test("handles empty lines array", async () => {
    const state = createPluginState()
    let receivedInput: string | undefined
    const client = createMockTransport({
      sendTerminalInput: (_terminalId, input) => {
        receivedInput = input
      },
    })

    const toolDef = createTerminalSendLinesTool(state, client, logger)
    const result = await toolDef.execute({ terminalId: "t1", lines: [] }, mockContext())

    assert.equal(receivedInput, "\n")
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.lineCount, 0)
    assert.equal(output.sent, 1)
  })

  await t.test("sent count matches joined string length", async () => {
    const state = createPluginState()
    const client = createMockTransport()

    const toolDef = createTerminalSendLinesTool(state, client, logger)
    const lines = ["first command", "second command", "third"]
    const result = await toolDef.execute({ terminalId: "t1", lines }, mockContext())

    const expectedLength = lines.join("\n").length + 1 // +1 for trailing newline
    const output = JSON.parse((result as { output: string }).output)
    assert.equal(output.sent, expectedLength)
    assert.equal(output.lineCount, 3)
  })
})

test("paseo_terminal_kill description warns to capture output first", () => {
  const logger = new Logger(false)
  const state = createPluginState()
  const client = createMockTransport()

  const toolDef = createTerminalKillTool(state, client, logger)

  assert.match(toolDef.description, /capture any important output/i)
  assert.match(toolDef.description, /paseo_terminal_capture/i)
  assert.match(toolDef.description, /buffers may not remain available afterward/i)
})

test("paseo_terminal_capture", async (t) => {
  const logger = new Logger(false)

  await t.test("passes explicit range and stripAnsi through to transport", async () => {
    const state = createPluginState()
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      captureTerminal: async (opts) => {
        received = opts as unknown as Record<string, unknown>
        return { terminalId: opts.terminalId, lines: ["line one", "line two"], totalLines: 8 }
      },
    })

    const toolDef = createTerminalCaptureTool(state, client, logger)
    const result = await toolDef.execute({ terminalId: "t1", start: 2, end: 4, stripAnsi: false }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(received, { terminalId: "t1", start: 2, end: 4, stripAnsi: false })
    assert.deepEqual(output, { terminalId: "t1", lines: ["line one", "line two"], totalLines: 8 })
    assert.equal("content" in output, false)
    assert.equal("lineCount" in output, false)
    assert.equal("truncated" in output, false)
    assert.equal("source" in output, false)
    assert.equal("warning" in output, false)
  })

  await t.test("scrollback captures from start of daemon buffer", async () => {
    const state = createPluginState()
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      captureTerminal: async (opts) => {
        received = opts as unknown as Record<string, unknown>
        return { terminalId: opts.terminalId, lines: ["first", "last"], totalLines: 2 }
      },
    })

    const result = await createTerminalCaptureTool(state, client, logger).execute(
      { terminalId: "t1", start: 99, end: 100, scrollback: true },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(received, { terminalId: "t1", start: 0, end: 100, stripAnsi: true })
    assert.deepEqual(output.lines, ["first", "last"])
    assert.equal(output.totalLines, 2)
  })

  await t.test("omits range fields when defaults are used", async () => {
    const state = createPluginState()
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      captureTerminal: async (opts) => {
        received = opts as unknown as Record<string, unknown>
        return { terminalId: opts.terminalId, lines: [], totalLines: 0 }
      },
    })

    const result = await createTerminalCaptureTool(state, client, logger).execute({ terminalId: "t1" }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(received, { terminalId: "t1", stripAnsi: true })
    assert.deepEqual(output, { terminalId: "t1", lines: [], totalLines: 0 })
  })
})

test("paseo_terminal_list returns daemon terminals only", async () => {
  const logger = new Logger(false)
  const state = createPluginState()
  state.terminals.set("t1", {
    id: "t1",
    title: "Term 1",
    cwd: "/tmp",
    status: "running",
    lineCount: 3,
    lastReadCursor: 0,
  })
  const client = createMockTransport({
    listTerminals: async () => [],
  })

  const listResult = await createTerminalListTool(state, client, logger).execute({}, mockContext())
  const output = JSON.parse((listResult as { output: string }).output)

  assert.equal(output.count, 0)
  assert.deepEqual(output.terminals, [])
})

test("paseo_terminal_list filters by current cwd unless all is true", async () => {
  const logger = new Logger(false)
  const state = createPluginState()
  const received: Array<string | undefined> = []
  const client = createMockTransport({
    listTerminals: async (cwd) => {
      received.push(cwd)
      return [{ id: "daemon-t1", name: "t1", title: "Term 1" }]
    },
  })

  await createTerminalListTool(state, client, logger).execute({}, mockContext())
  await createTerminalListTool(state, client, logger).execute({ cwd: "/other" }, mockContext())
  await createTerminalListTool(state, client, logger).execute({ all: true }, mockContext())

  assert.deepEqual(received, ["/tmp", "/other", undefined])
})

test("paseo_terminal_create creates shell terminal without command or args support", async () => {
  const logger = new Logger(false)
  const state = createPluginState()
  let received: Record<string, unknown> | undefined
  const client = createMockTransport({
    createTerminal: async (opts) => {
      received = opts as unknown as Record<string, unknown>
      return { id: "t1", name: "t1", title: "Term 1", cwd: opts.cwd }
    },
  })

  const toolDef = createTerminalCreateTool(state, client, logger)
  assert.equal("command" in toolDef.args, false)
  assert.equal("args" in toolDef.args, false)

  const result = await toolDef.execute({ cwd: "/tmp", name: "term", agentId: "agent-1" }, mockContext())
  const output = JSON.parse((result as { output: string }).output)

  assert.deepEqual(received, { cwd: "/tmp", name: "term", agentId: "agent-1" })
  assert.equal(output.id, "t1")
  assert.equal(output.status, "running")
})
