import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger.js"
import { createPermissionRespondTool } from "../lib/tools/permission.js"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import type { ToolContext } from "@opencode-ai/plugin/tool"

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
  return {
    respondToPermission: async (opts) => ({
      workerId: opts.workerId,
      permissionId: opts.permissionId,
      behavior: opts.behavior,
    }),
    ...overrides,
  } as PaseoTransport
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

test("paseo_permission_respond", async (t) => {
  const logger = new Logger(false)

  await t.test("treats null optional args as omitted", async () => {
    const state = createPluginState()
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      respondToPermission: async (opts) => {
        received = opts as unknown as Record<string, unknown>
        return { workerId: opts.workerId, permissionId: opts.permissionId, behavior: opts.behavior }
      },
    })

    await createPermissionRespondTool(state, client, logger).execute(
      {
        workerId: "w1",
        permissionId: "perm-1",
        behavior: "deny",
        message: null,
        interrupt: null,
        selectedActionId: null,
      },
      mockContext(),
    )

    assert.deepEqual(received, { workerId: "w1", permissionId: "perm-1", behavior: "deny" })
  })
})
