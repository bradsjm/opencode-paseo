import test from "node:test"
import assert from "node:assert/strict"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { Logger } from "../lib/logger.js"
import type { OpencodeClient } from "../lib/profile.js"
import { createPluginState, recordTaskRun } from "../lib/state/state.js"
import { createTaskTool } from "../lib/tools/task.js"
import type { AgentSummary, PaseoTransport, RunWorkerOptions } from "../lib/transport/types.js"
import { TASK_PARENT_SESSION_LABEL, TASK_SESSION_LABEL, TASK_SUBAGENT_LABEL } from "../lib/task-labels.js"

function mockContext(): ToolContext {
  return {
    sessionID: "parent-session",
    messageID: "msg-1",
    agent: "build",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

interface PromptCall {
  sessionId: string
  text: string
}

function mockOpencodeClient(sessionIds: string[] = ["task-session-1"], promptCalls: PromptCall[] = []): OpencodeClient {
  return {
    app: {
      agents: async () => ({
        data: [
          {
            name: "general",
            description: "General subagent",
            mode: "subagent",
            model: { providerID: "openai", modelID: "gpt-5.4" },
            permission: {},
          },
        ],
      }),
    },
    session: {
      create: async () => ({ data: { id: sessionIds.shift() ?? "task-session-next" } }),
      promptAsync: async (input: { path: { id: string }; body?: { parts?: Array<{ text?: string }> } }) => {
        promptCalls.push({ sessionId: input.path.id, text: input.body?.parts?.[0]?.text ?? "" })
        return { data: undefined }
      },
    },
  } as unknown as OpencodeClient
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function mockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
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
    captureTerminal: async () => ({ terminalId: "t", lines: [], totalLines: 0 }),
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
      cwd: "/tmp/project",
      model: null,
      status: "running",
      title: null,
    }),
    runWorker: async () => ({
      id: "worker-1",
      provider: "opencode",
      cwd: "/tmp/project",
      model: "openai/gpt-5.4",
      status: "running",
      title: "worker",
    }),
    sendWorkerMessage: async () => {},
    waitForWorker: async (workerId) => ({
      status: "idle",
      workerId,
      error: null,
      lastMessage: "done",
      finalSnapshot: null,
    }),
    cancelWorker: async () => {},
    killWorker: async () => {},
    archiveWorker: async (workerId) => ({ workerId, archivedAt: new Date().toISOString() }),
    fetchWorker: async () => null,
    updateWorker: async (opts) => ({
      workerId: opts.workerId,
      updated: true,
      metadataUpdated: false,
      settingsUpdated: false,
      errors: [],
    }),
    fetchWorkerActivity: async (opts) => ({ workerId: opts.workerId, activity: null }),
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

function structuredResult(result: Awaited<ReturnType<ReturnType<typeof createTaskTool>["execute"]>>) {
  if (typeof result === "string") throw new Error("expected structured task result")
  return result
}

function assertFreshTaskResult(result: ReturnType<typeof structuredResult>, runOptions: RunWorkerOptions | undefined) {
  assert.match(result.output, /<task id="task-session-1" state="completed">/)
  assert.equal(result.metadata?.sessionId, "task-session-1")
  assert.equal(result.metadata?.paseoWorkerId, "worker-1")
  assert.equal(runOptions?.initialPrompt, "do the work")
  assert.equal(runOptions?.modeId, "general")
  assertTaskLabels(runOptions?.labels)
}

function assertTaskLabels(labels: Record<string, string> | undefined) {
  assert.equal(labels?.[TASK_SESSION_LABEL], "task-session-1")
  assert.equal(labels?.[TASK_PARENT_SESSION_LABEL], "parent-session")
  assert.equal(labels?.[TASK_SUBAGENT_LABEL], "general")
}

test("task tool launches a fresh Paseo-backed task", async () => {
  const state = createPluginState()
  const promptCalls: PromptCall[] = []
  let runOptions: RunWorkerOptions | undefined
  const toolDef = createTaskTool(
    state,
    mockTransport({
      runWorker: async (opts) => {
        runOptions = opts
        return {
          id: "worker-1",
          provider: "opencode",
          cwd: opts.cwd,
          model: opts.model ?? null,
          status: "running",
          title: "worker",
        }
      },
    }),
    mockOpencodeClient(["task-session-1"], promptCalls),
    new Logger(false),
  )

  const result = await toolDef.execute(
    { description: "inspect bug", prompt: "do the work", subagent_type: "general" },
    mockContext(),
  )

  assertFreshTaskResult(structuredResult(result), runOptions)
  assert.equal(state.taskRuns.get("task-session-1")?.workerId, "worker-1")
  assert.equal(state.sessions.get("parent-session")?.createdWorkerIds.has("worker-1"), true)
  assert.deepEqual(promptCalls, [
    { sessionId: "task-session-1", text: "do the work" },
    {
      sessionId: "task-session-1",
      text: '<task id="task-session-1" state="completed">\n<summary>Task completed: inspect bug</summary>\n<task_result>\ndone\n</task_result>\n</task>',
    },
  ])
  assert.equal(state.ephemeralWorkerRuns.size, 0)
})

test("task tool resumes a known task id", async () => {
  const state = createPluginState()
  recordTaskRun(state, {
    taskSessionId: "task-session-existing",
    parentSessionId: "parent-session",
    workerId: "worker-existing",
    description: "inspect bug",
    subagentType: "general",
    background: true,
    createdAt: 1,
  })
  const sent: Array<{ workerId: string; message: string }> = []
  let createCalled = false
  const opencode = mockOpencodeClient()
  opencode.session.create = async () => {
    createCalled = true
    return { data: { id: "unexpected" } } as any
  }
  const toolDef = createTaskTool(
    state,
    mockTransport({
      sendWorkerMessage: async (workerId, message) => {
        sent.push({ workerId, message })
      },
    }),
    opencode,
    new Logger(false),
  )

  const result = await toolDef.execute(
    {
      description: "inspect bug",
      prompt: "continue work",
      subagent_type: "general",
      task_id: "task-session-existing",
      background: true,
    },
    mockContext(),
  )

  assert.deepEqual(sent, [{ workerId: "worker-existing", message: "continue work" }])
  assert.equal(createCalled, false)
  const structured = structuredResult(result)
  assert.match(structured.output, /state="running"/)
  assert.equal(structured.metadata?.sessionId, "task-session-existing")
})

test("background task completion injects actual worker result into parent and child sessions", async () => {
  const state = createPluginState()
  const promptCalls: PromptCall[] = []
  const toolDef = createTaskTool(
    state,
    mockTransport({
      waitForWorker: async (workerId) => ({
        status: "idle",
        workerId,
        error: null,
        lastMessage: "actual worker result",
        finalSnapshot: null,
      }),
    }),
    mockOpencodeClient(["task-session-bg"], promptCalls),
    new Logger(false),
  )

  await toolDef.execute(
    { description: "inspect bug", prompt: "background work", subagent_type: "general", background: true },
    mockContext(),
  )
  await flushAsyncWork()

  assert.deepEqual(promptCalls, [
    { sessionId: "task-session-bg", text: "background work" },
    {
      sessionId: "parent-session",
      text: '<task id="task-session-bg" state="completed">\n<summary>Background task completed: inspect bug</summary>\n<task_result>\nactual worker result\n</task_result>\n</task>',
    },
    {
      sessionId: "task-session-bg",
      text: '<task id="task-session-bg" state="completed">\n<summary>Background task completed: inspect bug</summary>\n<task_result>\nactual worker result\n</task_result>\n</task>',
    },
  ])
})

test("task tool treats permission wait as running instead of completed", async () => {
  const state = createPluginState()
  let waitCalls = 0
  const toolDef = createTaskTool(
    state,
    mockTransport({
      waitForWorker: async (workerId) => {
        waitCalls += 1
        return waitCalls === 1
          ? {
              status: "permission",
              workerId,
              error: null,
              lastMessage: null,
              finalSnapshot: null,
            }
          : {
              status: "idle",
              workerId,
              error: null,
              lastMessage: "approved result",
              finalSnapshot: null,
            }
      },
    }),
    mockOpencodeClient(["task-session-permission"]),
    new Logger(false),
  )

  const result = await toolDef.execute(
    { description: "inspect bug", prompt: "needs approval", subagent_type: "general" },
    mockContext(),
  )

  const structured = structuredResult(result)
  assert.match(structured.output, /state="running"/)
  assert.match(structured.output, /waiting for a permission response/i)
  assert.equal(waitCalls, 2)
})

test("background task completion watcher is deduped per worker", async () => {
  const state = createPluginState()
  let waitCalls = 0
  const promptCalls: PromptCall[] = []
  const toolDef = createTaskTool(
    state,
    mockTransport({
      waitForWorker: async (workerId) => {
        waitCalls += 1
        await flushAsyncWork()
        return {
          status: "idle",
          workerId,
          error: null,
          lastMessage: "deduped result",
          finalSnapshot: null,
        }
      },
    }),
    mockOpencodeClient(["task-session-dedupe"], promptCalls),
    new Logger(false),
  )

  await toolDef.execute(
    { description: "inspect bug", prompt: "background work", subagent_type: "general", background: true },
    mockContext(),
  )
  await toolDef.execute(
    {
      description: "inspect bug",
      prompt: "more context",
      subagent_type: "general",
      task_id: "task-session-dedupe",
      background: true,
    },
    mockContext(),
  )
  await flushAsyncWork()
  await flushAsyncWork()

  assert.equal(waitCalls, 1)
  assert.equal(promptCalls.filter((call) => call.text.includes("deduped result")).length, 2)
})

test("task tool falls back to fresh launch for missing task id", async () => {
  const state = createPluginState()
  const toolDef = createTaskTool(
    state,
    mockTransport(),
    mockOpencodeClient(["task-session-fallback"]),
    new Logger(false),
  )

  const result = await toolDef.execute(
    { description: "inspect bug", prompt: "restart work", subagent_type: "general", task_id: "missing" },
    mockContext(),
  )

  assert.equal(structuredResult(result).metadata?.sessionId, "task-session-fallback")
  assert.equal(state.taskRuns.get("task-session-fallback")?.workerId, "worker-1")
})

test("task tool restores resume mapping from daemon labels", async () => {
  const state = createPluginState()
  const agent: AgentSummary = {
    id: "worker-labeled",
    provider: "opencode",
    cwd: "/tmp/project",
    model: "openai/gpt-5.4",
    status: "running",
    title: "worker",
    labels: {
      [TASK_SESSION_LABEL]: "task-session-labeled",
      [TASK_PARENT_SESSION_LABEL]: "parent-session",
      [TASK_SUBAGENT_LABEL]: "general",
    },
  }
  const sent: string[] = []
  const toolDef = createTaskTool(
    state,
    mockTransport({
      fetchAgents: async () => [agent],
      sendWorkerMessage: async (_workerId, message) => {
        sent.push(message)
      },
    }),
    mockOpencodeClient(),
    new Logger(false),
  )

  const result = await toolDef.execute(
    {
      description: "inspect bug",
      prompt: "resume from labels",
      subagent_type: "general",
      task_id: "task-session-labeled",
      background: true,
    },
    mockContext(),
  )

  assert.deepEqual(sent, ["resume from labels"])
  assert.equal(state.taskRuns.get("task-session-labeled")?.workerId, "worker-labeled")
  assert.equal(structuredResult(result).metadata?.sessionId, "task-session-labeled")
})
