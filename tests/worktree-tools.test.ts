import test from "node:test"
import assert from "node:assert/strict"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { createPluginState, insertInboxEvent } from "../lib/state/state.js"
import type { WorkerSummary } from "../lib/state/types.js"
import { Logger } from "../lib/logger.js"
import { createWorktreeArchiveTool } from "../lib/tools/worktree.js"
import type { PaseoTransport } from "../lib/transport/types.js"

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
  return {
    archiveWorktree: async () => ({ requestId: "req", success: true, error: null }),
    ...overrides,
  } as PaseoTransport
}

function seedWorker(state: ReturnType<typeof createPluginState>, id: string): WorkerSummary {
  const worker: WorkerSummary = {
    id,
    title: `Worker ${id}`,
    agent: "test",
    provider: "test",
    model: null,
    currentModeId: null,
    status: "running",
    cwd: "/tmp",
    labels: [],
    pendingPermissions: [],
    pendingPermissionIds: [],
    rawStatus: "running",
    requiresAttention: false,
    attentionReason: null,
    runtimeInfo: null,
    persistence: null,
    unreadEventCount: 0,
  }
  state.workers.set(id, worker)
  return worker
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

test("paseo_worktree_archive", async (t) => {
  const logger = new Logger(false)

  await t.test("removes daemon-reported removedAgents from local worker state", async () => {
    const state = createPluginState()
    seedWorker(state, "w-removed")
    seedWorker(state, "w-keep")
    state.sessions.set("sess-1", {
      opencodeSessionId: "sess-1",
      projectRoot: "/tmp",
      createdTerminalIds: new Set(),
      createdWorkerIds: new Set(["w-removed", "w-keep"]),
      unreadEvents: new Map(),
      pendingPermissions: new Map(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    insertInboxEvent(state, {
      id: "evt-removed",
      kind: "worker.blocked",
      resourceId: "w-removed",
      blocking: true,
      summary: "removed worker event",
      read: false,
      timestamp: Date.now(),
    })
    insertInboxEvent(state, {
      id: "evt-keep",
      kind: "worker.started",
      resourceId: "w-keep",
      blocking: false,
      summary: "keep worker event",
      read: false,
      timestamp: Date.now(),
    })

    const client = createMockTransport({
      archiveWorktree: async () => ({
        requestId: "req",
        success: true,
        removedAgents: ["w-removed"],
        error: null,
      }),
    })

    const toolDef = createWorktreeArchiveTool(state, client, logger)
    const result = await toolDef.execute({ worktreePath: "/tmp/wt" }, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(state.workers.has("w-removed"), false)
    assert.equal(state.workers.has("w-keep"), true)
    assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w-removed"), false)
    assert.equal(state.sessions.get("sess-1")?.createdWorkerIds.has("w-keep"), true)
    assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-removed"), false)
    assert.equal(state.sessions.get("sess-1")?.pendingPermissions.has("evt-removed"), false)
    assert.equal(state.sessions.get("sess-1")?.unreadEvents.has("evt-keep"), true)
    assert.equal(state.inbox.has("evt-removed"), true)
    assert.deepEqual(output.removedAgents, ["w-removed"])
  })

  await t.test("missing removedAgents leaves unrelated workers intact", async () => {
    const state = createPluginState()
    seedWorker(state, "w-keep")

    const toolDef = createWorktreeArchiveTool(state, createMockTransport(), logger)
    await toolDef.execute({ worktreePath: "/tmp/wt" }, mockContext())

    assert.equal(state.workers.has("w-keep"), true)
  })
})
