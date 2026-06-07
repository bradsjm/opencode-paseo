import type { AgentSummary } from "../transport/types.js"

/** Stable label key used to store a worker's chat room. */
export const RESERVED_CHAT_ROOM_LABEL = "opencodePaseo.chatRoom"

/**
 * Normalizes an optional chat room string to a trimmed value.
 *
 * @param chatRoom - The configured chat room value.
 * @returns The trimmed chat room name, or `undefined` when no room is set.
 */
export function normalizeChatRoom(chatRoom: string | null | undefined): string | undefined {
  if (chatRoom === undefined || chatRoom === null) {
    return undefined
  }

  const normalized = chatRoom.trim()
  if (!normalized) {
    throw new Error("chatRoom must be a non-empty string when provided")
  }

  return normalized
}

/**
 * Reads the reserved chat room label from an agent's label set.
 *
 * @param labels - The agent labels to inspect.
 * @returns The trimmed chat room name when present, otherwise `undefined`.
 */
export function getChatRoomFromAgentLabels(labels: AgentSummary["labels"] | undefined): string | undefined {
  if (!labels || Array.isArray(labels)) {
    return undefined
  }

  const value = labels[RESERVED_CHAT_ROOM_LABEL]
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized || undefined
}

/**
 * Appends chat coordination instructions to an existing worker prompt.
 *
 * @param initialPrompt - The existing worker prompt, if any.
 * @param chatRoom - The chat room to reference in the coordination block.
 * @returns The prompt with chat coordination instructions appended.
 */
export function appendChatRoomCoordinationPrompt(initialPrompt: string | undefined, chatRoom: string): string {
  const block = [
    "Paseo chat coordination instructions:",
    `- Use the Paseo chat room "${chatRoom}" with the available Paseo chat tools: CLI-style \`paseo chat post/read/wait\` or plugin tools such as \`paseo_chat_post\`, \`paseo_chat_read\`, and \`paseo_chat_wait\`.`,
    "- Rely on the automatic PASEO_AGENT_ID author identity when posting to chat unless explicitly instructed otherwise.",
    "- Post a start/claim message, meaningful progress, blockers needing coordinator action, and final completion in that room.",
    "- Final chat updates should include status, changed files or artifacts, verification run/results, risks, and remaining blockers.",
    "- For reliable plugin nudges, mention coworkers with exact `@<worker-id>` tokens.",
  ].join("\n")

  if (!initialPrompt) {
    return block
  }

  const separator = initialPrompt.endsWith("\n") ? "\n" : "\n\n"
  return `${initialPrompt}${separator}${block}`
}
