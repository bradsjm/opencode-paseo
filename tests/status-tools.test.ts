import test from "node:test"
import assert from "node:assert/strict"
import { createStatusTool } from "../lib/tools/status.js"
import { createPluginState, insertInboxEvent, setConnectionStatus, setCapabilities } from "../lib/state/state.js"
import { Logger } from "../lib/logger.js"

function mockContext() {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test",
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  } as any
}

test("createStatusTool", async (t) => {
  const logger = new Logger(false)

  await t.test("returns ready status when no action is required", async () => {
    const state = createPluginState()
    setConnectionStatus(state, "connected")
    setCapabilities(state, { version: "0.1.0", features: ["workers"], fetchedAt: Date.now() })

    const toolDef = createStatusTool(state, logger)
    const result = await toolDef.execute({}, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.pluginLoaded, true)
    assert.equal(output.connected, true)
    assert.equal(output.readiness, "ready")
    assert.equal(output.actionRequired, false)
    assert.equal(output.nextAction, null)
  })

  await t.test("surfaces the primary blocking next action and suggested tool", async () => {
    const state = createPluginState()
    setConnectionStatus(state, "connected")
    insertInboxEvent(state, {
      id: "evt-1",
      kind: "permission.requested",
      resourceId: "worker-1",
      blocking: true,
      summary: "Worker needs write permission",
      read: false,
      timestamp: Date.now(),
      metadata: {
        actionKind: "permission",
        workerId: "worker-1",
        permissionId: "perm-1",
        suggestedTool: "paseo_permission_respond",
      },
    })

    const toolDef = createStatusTool(state, logger)
    const result = await toolDef.execute({}, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.readiness, "action_required")
    assert.equal(output.actionRequired, true)
    assert.deepEqual(output.nextAction, {
      kind: "permission.requested",
      resourceId: "worker-1",
      summary: "Worker needs write permission",
      actionKind: "permission",
      suggestedTool: "paseo_permission_respond",
    })
    assert.equal(output.blockingSummary.permissionRequests, 1)
    assert.equal(output.blockingSummary.bySuggestedTool.paseo_permission_respond, 1)
  })

  await t.test("reports degraded readiness when the daemon disconnects", async () => {
    const state = createPluginState()
    setConnectionStatus(state, "error", "Daemon disconnected")

    const toolDef = createStatusTool(state, logger)
    const result = await toolDef.execute({}, mockContext())
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(output.connected, false)
    assert.equal(output.readiness, "degraded")
    assert.equal(output.actionRequired, true)
    assert.deepEqual(output.nextAction, {
      kind: "daemon.disconnected",
      resourceId: "daemon",
      summary: "Daemon disconnected",
      actionKind: "daemon",
      suggestedTool: null,
    })
  })
})
