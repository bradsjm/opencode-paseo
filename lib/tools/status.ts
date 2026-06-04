import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"

// ─── Daemon Status Tool ──────────────────────────────────────────────────────

export function createStatusTool(
    state: PluginState,
    _client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description: "Check Paseo daemon connection status and current state summary",
        args: {},
        async execute() {
            logger.info("Tool: paseo_status invoked")

            const unreadEvents = Array.from(state.inbox.values()).filter((e) => !e.read)
            const blockingEvents = unreadEvents.filter((e) => e.blocking)

            // Derive actionable blocking summary
            let permissionRequests = 0
            let blockedWorkers = 0

            for (const evt of blockingEvents) {
                const actionKind = evt.metadata?.actionKind as string | undefined
                if (actionKind === "permission" || evt.kind === "permission.requested") {
                    permissionRequests++
                } else if (actionKind === "worker-question" || evt.kind === "worker.blocked") {
                    blockedWorkers++
                }
            }

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
                        inboxBlocking: blockingEvents.length,
                        blockingSummary: {
                            total: blockingEvents.length,
                            permissionRequests,
                            blockedWorkers,
                        },
                    },
                    null,
                    2,
                ),
            }
        },
    })
}
