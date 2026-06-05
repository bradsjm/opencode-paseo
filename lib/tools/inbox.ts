import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { Logger } from "../logger.js"
import { readInbox, getInboxStatus } from "../inbox/inbox.js"

// ─── Inbox Read Tool ─────────────────────────────────────────────────────────

const inboxEventKinds = [
    "worker.started",
    "worker.finished",
    "worker.failed",
    "worker.blocked",
    "permission.requested",
    "permission.resolved",
    "daemon.connected",
    "daemon.disconnected",
] as const

export function createInboxReadTool(state: PluginState, logger: Logger): ToolDefinition {
    return tool({
        description:
            "Read Paseo inbox events with filtering and pagination. Returns unread events, blocking items, and permission requests.",
        args: {
            unreadOnly: tool.schema.boolean().optional().describe("Only return unread events"),
            kind: tool.schema.enum(inboxEventKinds).optional().describe("Filter by event kind"),
            resourceId: tool.schema
                .string()
                .optional()
                .describe("Filter by resource ID (worker or terminal ID)"),
            cursor: tool.schema.number().int().optional().describe("Pagination cursor (offset)"),
            limit: tool.schema.number().int().optional().describe("Maximum events to return"),
            markRead: tool.schema.boolean().optional().describe("Mark returned events as read"),
        },
        async execute(args) {
            logger.info("Tool: paseo_inbox_read invoked", {
                unreadOnly: args.unreadOnly,
                kind: args.kind,
            })

            const result = readInbox(state, {
                ...(args.unreadOnly !== undefined ? { unreadOnly: args.unreadOnly } : {}),
                ...(args.kind !== undefined ? { kind: args.kind } : {}),
                ...(args.resourceId !== undefined ? { resourceId: args.resourceId } : {}),
                ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.markRead !== undefined ? { markRead: args.markRead } : {}),
            })

            return {
                title: "Paseo Inbox",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Inbox Status Tool ───────────────────────────────────────────────────────

export function createInboxStatusTool(state: PluginState, logger: Logger): ToolDefinition {
    return tool({
        description:
            "Get a summary of the Paseo inbox: unread count, blocking count, and breakdowns by kind and resource.",
        args: {},
        async execute() {
            logger.info("Tool: paseo_inbox_status invoked")
            const result = getInboxStatus(state)
            return {
                title: "Paseo Inbox Status",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}
