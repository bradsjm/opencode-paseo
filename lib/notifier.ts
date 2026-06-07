// ─── Session Nudge Delivery ──────────────────────────────────────────────────
// Best-effort OpenCode session nudges for Paseo async events.
// Nudges are synthetic text parts injected into the controller's session so
// the LLM becomes aware of daemon state changes without polling.

import type { OpencodeClient } from "./profile.js"
import type { InboxEventKind } from "./state/types.js"
import type { Logger } from "./logger.js"

// ─── Message Formatting ──────────────────────────────────────────────────────

/**
 * Build a concise nudge message for injection into a controller session.
 *
 * @param kind Inbox event kind that triggered the nudge.
 * @param resourceId Resource identifier associated with the event.
 * @param summary Human-readable event summary.
 * @returns The formatted nudge message.
 */
export function formatNudgeMessage(kind: InboxEventKind, resourceId: string, summary: string): string {
  const prefix = `[paseo:${kind}]`
  return `${prefix} ${summary} (resource: ${resourceId})`
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * Send a best-effort nudge to one or more OpenCode sessions.
 *
 * Failures are logged but never thrown; nudges are fire-and-forget.
 *
 * @param client OpenCode client used to deliver session prompts.
 * @param sessionIds Session identifiers to nudge.
 * @param message Message body to inject.
 * @param logger Logger used for success and failure reporting.
 * @returns Nothing.
 */
export function sendNudge(client: OpencodeClient, sessionIds: string[], message: string, logger: Logger): void {
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
      .catch((err: unknown) => {
        logger.warn("Nudge delivery failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }
}
