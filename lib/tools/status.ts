import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoClient } from "../transport/client.js"
import type { Logger } from "../logger.js"

// ─── Daemon Status Tool ──────────────────────────────────────────────────────

export function createStatusTool(
    state: PluginState,
    client: PaseoClient,
    logger: Logger,
): ToolDefinition {
    return tool({
        description: "Check Paseo daemon connection status and current state summary",
        args: {},
        async execute() {
            logger.info("Tool: paseo_status invoked")

            const unreadEvents = Array.from(state.inbox.values()).filter((e) => !e.read)

            return {
                title: "Paseo Status",
                output: JSON.stringify(
                    {
                        connected: state.connectionStatus === "connected",
                        version: state.capabilities?.version ?? null,
                        features: state.capabilities?.features ?? [],
                        lastError: state.lastError ?? null,
                        workers: state.workers.size,
                        terminals: state.terminals.size,
                        inboxUnread: unreadEvents.length,
                        inboxBlocking: unreadEvents.filter((e) => e.blocking).length,
                    },
                    null,
                    2,
                ),
            }
        },
    })
}
