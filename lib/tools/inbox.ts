import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { Logger } from "../logger.js"
import { readInbox, getInboxStatus } from "../inbox/inbox.js"
import { collapseNull, compactDefined, nullableOptional, optionalNumber } from "./args.js"

// ─── Inbox Read Tool ─────────────────────────────────────────────────────────

const inboxEventKinds = [
  "agent.status",
  "agent.attention",
  "worker.stalled",
  "chat.mentioned",
  "permission.requested",
  "daemon.connected",
  "daemon.disconnected",
] as const

/** Create the tool that reads Paseo inbox events.
 *
 * @param state - Plugin state used to read inbox events.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for reading inbox events.
 */
export function createInboxReadTool(state: PluginState, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Read Paseo inbox events with filtering and pagination. Returns unread events, blocking items, and permission requests.",
    args: {
      unreadOnly: nullableOptional(tool.schema.boolean()).describe("Only return unread events"),
      kind: tool.schema.enum(inboxEventKinds).nullable().optional().describe("Filter by event kind"),
      resourceId: nullableOptional(tool.schema.string()).describe("Filter by resource ID (worker or terminal ID)"),
      cursor: nullableOptional(tool.schema.number().int()).describe("Pagination cursor (offset)"),
      limit: nullableOptional(tool.schema.number().int()).describe("Maximum events to return"),
      markRead: nullableOptional(tool.schema.boolean()).describe("Mark returned events as read"),
    },
    execute(args) {
      return Promise.resolve().then(() => {
        const unreadOnly = collapseNull(args.unreadOnly)
        const kind = collapseNull(args.kind)
        const resourceId = collapseNull(args.resourceId)
        const cursor = optionalNumber(args.cursor)
        const limit = optionalNumber(args.limit)
        const markRead = collapseNull(args.markRead)
        logger.info("Tool: paseo_inbox_read invoked", {
          unreadOnly,
          kind,
        })

        const result = readInbox(state, compactDefined({ unreadOnly, kind, resourceId, cursor, limit, markRead }))

        return {
          title: "Paseo Inbox",
          output: JSON.stringify(result, null, 2),
        }
      })
    },
  })
}

// ─── Inbox Status Tool ───────────────────────────────────────────────────────

/** Create the tool that summarizes the Paseo inbox.
 *
 * @param state - Plugin state used to compute inbox status.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for summarizing inbox status.
 */
export function createInboxStatusTool(state: PluginState, logger: Logger): ToolDefinition {
  return tool({
    description: "Get a summary of the Paseo inbox: unread count, blocking count, and breakdowns by kind and resource.",
    args: {},
    execute() {
      return Promise.resolve().then(() => {
        logger.info("Tool: paseo_inbox_status invoked")
        const result = getInboxStatus(state)
        return {
          title: "Paseo Inbox Status",
          output: JSON.stringify(result, null, 2),
        }
      })
    },
  })
}
