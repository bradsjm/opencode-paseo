import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { normalizeChatRoom } from "../chat/worker-room.js"
import { collapseNull, compactDefined, nullableOptional, optionalNumber } from "./args.js"

function requireChatRoom(room: string): string {
  const normalized = normalizeChatRoom(room)
  if (!normalized) {
    throw new Error("room must be a non-empty string")
  }
  return normalized
}

/** Create the tool that opens a new Paseo chat room.
 *
 * @param client - Transport used to create the chat room.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for creating chat rooms.
 */
export function createChatCreateTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Create a new Paseo chat room.",
    args: {
      name: tool.schema.string().describe("Name of the chat room to create"),
      purpose: nullableOptional(tool.schema.string()).describe("Optional room purpose"),
    },
    async execute(args) {
      const name = requireChatRoom(args.name)
      const purpose = collapseNull(args.purpose)
      logger.info("Tool: paseo_chat_create invoked", { name })
      const result = await client.createChatRoom({ name, ...compactDefined({ purpose }) })
      return {
        title: `Chat Room Created: ${name}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/** Create the tool that lists all Paseo chat rooms.
 *
 * @param client - Transport used to list chat rooms.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for listing chat rooms.
 */
export function createChatListTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "List all Paseo chat rooms.",
    args: {},
    async execute() {
      logger.info("Tool: paseo_chat_list invoked")
      const result = await client.listChatRooms()
      return {
        title: "Paseo Chat Rooms",
        output: JSON.stringify({ ...result, count: result.rooms.length }, null, 2),
      }
    },
  })
}

/** Create the tool that inspects a specific Paseo chat room.
 *
 * @param client - Transport used to inspect the chat room.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for inspecting chat rooms.
 */
export function createChatInspectTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Inspect a specific Paseo chat room.",
    args: {
      room: tool.schema.string().describe("Name of the chat room to inspect"),
    },
    async execute(args) {
      const room = requireChatRoom(args.room)
      logger.info("Tool: paseo_chat_inspect invoked", { room })
      const result = await client.inspectChatRoom({ room })
      return {
        title: `Chat Room: ${room}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/** Create the tool that deletes a Paseo chat room.
 *
 * @param client - Transport used to delete the chat room.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for deleting chat rooms.
 */
export function createChatDeleteTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Delete a Paseo chat room permanently.",
    args: {
      room: tool.schema.string().describe("Name of the chat room to delete"),
    },
    async execute(args) {
      const room = requireChatRoom(args.room)
      logger.info("Tool: paseo_chat_delete invoked", { room })
      const result = await client.deleteChatRoom({ room })
      return {
        title: `Chat Room Deleted: ${room}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/** Create the tool that posts a message into a Paseo chat room.
 *
 * @param client - Transport used to post the message.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for posting chat messages.
 */
export function createChatPostTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Post a message to a Paseo chat room.",
    args: {
      room: tool.schema.string().describe("Name of the chat room to post into"),
      body: tool.schema.string().describe("Message body to post"),
      authorAgentId: nullableOptional(tool.schema.string()).describe('Optional author agent ID. Defaults to "manual".'),
      replyToMessageId: nullableOptional(tool.schema.string()).describe("Optional message ID to reply to"),
    },
    async execute(args) {
      const room = requireChatRoom(args.room)
      const authorAgentId = collapseNull(args.authorAgentId) ?? "manual"
      const replyToMessageId = collapseNull(args.replyToMessageId)
      logger.info("Tool: paseo_chat_post invoked", {
        room,
        bodyLength: args.body.length,
        authorAgentId,
      })
      const result = await client.postChatMessage({
        room,
        body: args.body,
        authorAgentId,
        ...compactDefined({ replyToMessageId }),
      })
      return {
        title: `Chat Message Posted: ${room}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/** Create the tool that reads messages from a Paseo chat room.
 *
 * @param client - Transport used to read chat messages.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for reading chat messages.
 */
export function createChatReadTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Read chat messages from a Paseo room.",
    args: {
      room: tool.schema.string().describe("Name of the chat room to read"),
      limit: nullableOptional(tool.schema.number().int()).describe("Maximum number of messages"),
      since: nullableOptional(tool.schema.string()).describe("Only return messages created after this timestamp"),
      authorAgentId: nullableOptional(tool.schema.string()).describe("Optional author agent ID filter"),
    },
    async execute(args) {
      const room = requireChatRoom(args.room)
      const limit = optionalNumber(args.limit)
      const since = collapseNull(args.since)
      const authorAgentId = collapseNull(args.authorAgentId)
      logger.info("Tool: paseo_chat_read invoked", {
        room,
        limit,
        since,
        authorAgentId,
      })
      const result = await client.readChatMessages({ room, ...compactDefined({ limit, since, authorAgentId }) })
      return {
        title: `Chat Messages: ${room}`,
        output: JSON.stringify({ ...result, count: result.messages.length }, null, 2),
      }
    },
  })
}

/** Create the tool that waits for newer messages in a Paseo chat room.
 *
 * @param client - Transport used to wait for chat messages.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for waiting on chat messages.
 */
export function createChatWaitTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Wait for new chat messages in a Paseo room. Reads the latest message first and waits for anything newer.",
    args: {
      room: tool.schema.string().describe("Name of the chat room to wait on"),
      timeoutMs: nullableOptional(tool.schema.number().int()).describe("Maximum time to wait in milliseconds"),
    },
    async execute(args) {
      const room = requireChatRoom(args.room)
      const timeoutMs = optionalNumber(args.timeoutMs)
      logger.info("Tool: paseo_chat_wait invoked", { room, timeoutMs })

      const latest = await client.readChatMessages({ room, limit: 1 })
      const afterMessageId = latest.messages[0]?.id ?? null
      const result = await client.waitForChatMessages({ room, afterMessageId, ...compactDefined({ timeoutMs }) })

      return {
        title: `Chat Wait: ${room}`,
        output: JSON.stringify({ ...result, afterMessageId }, null, 2),
      }
    },
  })
}
