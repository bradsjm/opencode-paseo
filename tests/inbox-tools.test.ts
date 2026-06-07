import assert from "node:assert/strict"
import test from "node:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { createPluginState, insertInboxEvent } from "../lib/state/state.js"
import { Logger } from "../lib/logger.js"
import { createInboxReadTool } from "../lib/tools/inbox.js"

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

test("paseo_inbox_read", async (t) => {
  const logger = new Logger(false)

  await t.test("treats null optional filters as omitted", async () => {
    const state = createPluginState()
    insertInboxEvent(state, {
      id: "evt-1",
      kind: "agent.status",
      resourceId: "w1",
      blocking: false,
      summary: "worker started",
      read: false,
      timestamp: Date.now(),
    })

    const result = await createInboxReadTool(state, logger).execute(
      {
        unreadOnly: null,
        kind: null,
        resourceId: null,
        cursor: null,
        limit: null,
        markRead: null,
      },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.events.length, 1)
    assert.equal(output.events[0].id, "evt-1")
    assert.equal(state.inbox.get("evt-1")?.read, false)
  })
})
