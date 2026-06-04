import test from "node:test"
import assert from "node:assert/strict"
import { shouldNudge, formatNudgeMessage } from "../lib/notifier.js"
import type { NotificationsConfig } from "../lib/config.js"
import type { InboxEventKind } from "../lib/state/types.js"

// ─── shouldNudge ─────────────────────────────────────────────────────────────

test("shouldNudge", async (t) => {
    const enabledAll: NotificationsConfig = { enabled: true, blockingOnly: false }
    const enabledBlockingOnly: NotificationsConfig = { enabled: true, blockingOnly: true }
    const disabled: NotificationsConfig = { enabled: false, blockingOnly: false }

    await t.test("returns false when notifications disabled", () => {
        assert.equal(shouldNudge("worker.blocked", disabled), false)
        assert.equal(shouldNudge("worker.finished", disabled), false)
        assert.equal(shouldNudge("permission.requested", disabled), false)
    })

    await t.test("never nudges worker.started", () => {
        assert.equal(shouldNudge("worker.started", enabledAll), false)
        assert.equal(shouldNudge("worker.started", enabledBlockingOnly), false)
    })

    await t.test("never nudges permission.resolved", () => {
        assert.equal(shouldNudge("permission.resolved", enabledAll), false)
        assert.equal(shouldNudge("permission.resolved", enabledBlockingOnly), false)
    })

    await t.test("never nudges daemon lifecycle events", () => {
        assert.equal(shouldNudge("daemon.connected", enabledAll), false)
        assert.equal(shouldNudge("daemon.disconnected", enabledAll), false)
    })

    await t.test("blocking events nudge when blockingOnly is true", () => {
        assert.equal(shouldNudge("worker.blocked", enabledBlockingOnly), true)
        assert.equal(shouldNudge("permission.requested", enabledBlockingOnly), true)
    })

    await t.test("non-blocking events do not nudge when blockingOnly is true", () => {
        assert.equal(shouldNudge("worker.finished", enabledBlockingOnly), false)
        assert.equal(shouldNudge("worker.failed", enabledBlockingOnly), false)
    })

    await t.test("all eligible events nudge when blockingOnly is false", () => {
        assert.equal(shouldNudge("worker.blocked", enabledAll), true)
        assert.equal(shouldNudge("permission.requested", enabledAll), true)
        assert.equal(shouldNudge("worker.finished", enabledAll), true)
        assert.equal(shouldNudge("worker.failed", enabledAll), true)
    })
})

// ─── formatNudgeMessage ──────────────────────────────────────────────────────

test("formatNudgeMessage", async (t) => {
    await t.test("includes kind prefix, summary, and resource ID", () => {
        const msg = formatNudgeMessage("worker.finished", "w1", "Worker completed task")
        assert.equal(msg, "[paseo:worker.finished] Worker completed task (resource: w1)")
    })

    await t.test("handles blocking event kind", () => {
        const msg = formatNudgeMessage(
            "permission.requested",
            "w2",
            "Write permission needed",
        )
        assert.equal(
            msg,
            "[paseo:permission.requested] Write permission needed (resource: w2)",
        )
    })

    await t.test("handles daemon lifecycle kind", () => {
        const msg = formatNudgeMessage("daemon.disconnected", "daemon", "Daemon disconnected")
        assert.equal(msg, "[paseo:daemon.disconnected] Daemon disconnected (resource: daemon)")
    })
})
