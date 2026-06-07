import test from "node:test"
import assert from "node:assert/strict"
import { formatNudgeMessage } from "../lib/notifier.js"

// ─── formatNudgeMessage ──────────────────────────────────────────────────────

test("formatNudgeMessage", async (t) => {
  await t.test("includes kind prefix, summary, and resource ID", () => {
    const msg = formatNudgeMessage("agent.status", "w1", "Worker completed task")
    assert.equal(msg, "[paseo:agent.status] Worker completed task (resource: w1)")
  })

  await t.test("handles blocking event kind", () => {
    const msg = formatNudgeMessage("permission.requested", "w2", "Write permission needed")
    assert.equal(msg, "[paseo:permission.requested] Write permission needed (resource: w2)")
  })

  await t.test("handles daemon lifecycle kind", () => {
    const msg = formatNudgeMessage("daemon.disconnected", "daemon", "Daemon disconnected")
    assert.equal(msg, "[paseo:daemon.disconnected] Daemon disconnected (resource: daemon)")
  })

  await t.test("handles chat mention kind", () => {
    const msg = formatNudgeMessage("chat.mentioned", "w3", 'Mentioned in room "ops"')
    assert.equal(msg, '[paseo:chat.mentioned] Mentioned in room "ops" (resource: w3)')
  })
})
