import type { AgentSummary } from "../transport/types.js"

export const RESERVED_CHAT_ROOM_LABEL = "opencodePaseo.chatRoom"

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

export function getChatRoomFromAgentLabels(
    labels: AgentSummary["labels"] | undefined,
): string | undefined {
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

export function appendChatRoomCoordinationPrompt(
    initialPrompt: string | undefined,
    chatRoom: string,
): string {
    const block = [
        "Paseo chat coordination instructions:",
        `- Use the Paseo chat room \"${chatRoom}\" with \`paseo chat post\`, \`paseo chat read\`, and \`paseo chat wait\`.`,
        "- Rely on the automatic PASEO_AGENT_ID author identity when posting to chat unless explicitly instructed otherwise.",
        "- Post progress updates, blockers, and final completion in that room.",
        "- For reliable plugin nudges, mention coworkers with exact `@<worker-id>` tokens.",
    ].join("\n")

    if (!initialPrompt) {
        return block
    }

    const separator = initialPrompt.endsWith("\n") ? "\n" : "\n\n"
    return `${initialPrompt}${separator}${block}`
}
