// ─── Session Nudge Delivery ──────────────────────────────────────────────────
// Best-effort OpenCode session nudges for Paseo async events.
// Nudges are synthetic text parts injected into the controller's session so
// the LLM becomes aware of daemon state changes without polling.

import type { OpencodeClient } from "./profile.js"
import type { NotificationsConfig } from "./config.js"
import type { InboxEventKind } from "./state/types.js"
import type { Logger } from "./logger.js"

// ─── Eligibility ─────────────────────────────────────────────────────────────

/** Event kinds that never produce nudges. */
const NEVER_NUDGE: ReadonlySet<InboxEventKind> = new Set([
    "worker.started",
    "permission.resolved",
    "daemon.connected",
    "daemon.disconnected",
])

/** Event kinds that are nudged only when blockingOnly is false. */
const NON_BLOCKING_NUDGE: ReadonlySet<InboxEventKind> = new Set([
    "worker.stalled",
    "worker.finished",
    "worker.failed",
    "chat.mentioned",
])

/** Event kinds that always produce nudges (when notifications enabled). */
const BLOCKING_NUDGE: ReadonlySet<InboxEventKind> = new Set([
    "worker.blocked",
    "permission.requested",
])

/**
 * Determine whether a given event kind should produce a session nudge.
 */
export function shouldNudge(kind: InboxEventKind, config: NotificationsConfig): boolean {
    if (!config.enabled) return false
    if (NEVER_NUDGE.has(kind)) return false
    if (config.blockingOnly) return BLOCKING_NUDGE.has(kind)
    return BLOCKING_NUDGE.has(kind) || NON_BLOCKING_NUDGE.has(kind)
}

// ─── Message Formatting ──────────────────────────────────────────────────────

/**
 * Build a concise nudge message for injection into the controller session.
 */
export function formatNudgeMessage(
    kind: InboxEventKind,
    resourceId: string,
    summary: string,
): string {
    const prefix = `[paseo:${kind}]`
    return `${prefix} ${summary} (resource: ${resourceId})`
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * Send a best-effort nudge to one or more OpenCode sessions.
 * Failures are logged but never thrown — nudges are fire-and-forget.
 * All prompts are fired concurrently without awaiting.
 */
export function sendNudge(
    client: OpencodeClient,
    sessionIds: string[],
    message: string,
    logger: Logger,
): void {
    for (const sessionId of sessionIds) {
        client.session
            .prompt({
                path: { id: sessionId },
                body: {
                    noReply: true,
                    parts: [{ type: "text", text: message, synthetic: true }],
                },
            })
            .then(() => {
                logger.debug("Nudge sent", { sessionId, messageLength: message.length })
            })
            .catch((err: any) => {
                logger.warn("Nudge delivery failed", {
                    sessionId,
                    error: err.message ?? String(err),
                })
            })
    }
}
