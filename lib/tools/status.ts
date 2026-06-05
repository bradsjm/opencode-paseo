import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"

// ─── Daemon Status Tool ──────────────────────────────────────────────────────

interface NextActionSummary {
  kind: string
  resourceId: string
  summary: string
  actionKind: string | null
  suggestedTool: string | null
}

function buildNextAction(
  state: PluginState,
  blockingEvents: Array<PluginState["inbox"] extends Map<any, infer T> ? T : never>,
): NextActionSummary | null {
  const primaryEvent = blockingEvents[0]
  if (primaryEvent) {
    return {
      kind: primaryEvent.kind,
      resourceId: primaryEvent.resourceId,
      summary: primaryEvent.summary,
      actionKind: typeof primaryEvent.metadata?.actionKind === "string" ? primaryEvent.metadata.actionKind : null,
      suggestedTool:
        typeof primaryEvent.metadata?.suggestedTool === "string" ? primaryEvent.metadata.suggestedTool : null,
    }
  }

  if (state.connectionStatus !== "connected") {
    return {
      kind: "daemon.disconnected",
      resourceId: "daemon",
      summary: state.lastError ?? "Paseo daemon is disconnected",
      actionKind: "daemon",
      suggestedTool: null,
    }
  }

  return null
}

export function createStatusTool(state: PluginState, _client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Check Paseo plugin readiness, daemon status, and next actions",
    args: {},
    execute() {
      return Promise.resolve().then(() => {
        logger.info("Tool: paseo_status invoked")

        const unreadEvents = Array.from(state.inbox.values()).filter((e) => !e.read)
        const blockingEvents = unreadEvents.filter((e) => e.blocking)
        const nextAction = buildNextAction(state, blockingEvents)

        // Derive actionable blocking summary
        let permissionRequests = 0
        let blockedWorkers = 0
        const bySuggestedTool: Record<string, number> = {}

        for (const evt of blockingEvents) {
          const actionKind = evt.metadata?.actionKind as string | undefined
          const suggestedTool = evt.metadata?.suggestedTool
          if (typeof suggestedTool === "string") {
            bySuggestedTool[suggestedTool] = (bySuggestedTool[suggestedTool] ?? 0) + 1
          }
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
              pluginLoaded: true,
              connected: state.connectionStatus === "connected",
              readiness:
                state.connectionStatus === "connected" ? (nextAction ? "action_required" : "ready") : "degraded",
              actionRequired: nextAction !== null,
              nextAction,
              version: state.capabilities?.version ?? null,
              features: state.capabilities?.features ?? [],
              lastError: state.lastError ?? null,
              workers: state.workers.size,
              chatRooms: state.chatRooms.size,
              terminals: state.terminals.size,
              inboxUnread: unreadEvents.length,
              inboxBlocking: blockingEvents.length,
              blockingSummary: {
                total: blockingEvents.length,
                permissionRequests,
                blockedWorkers,
                bySuggestedTool,
              },
            },
            null,
            2,
          ),
        }
      })
    },
  })
}
