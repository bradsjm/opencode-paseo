import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { InboxEvent } from "../state/types.js"
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

interface BlockingSummary {
  total: number
  permissionRequests: number
  blockedWorkers: number
  bySuggestedTool: Record<string, number>
}

function buildNextAction(state: PluginState, blockingEvents: InboxEvent[]): NextActionSummary | null {
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
        return {
          title: "Paseo Status",
          output: JSON.stringify(buildStatusPayload(state), null, 2),
        }
      })
    },
  })
}

function buildStatusPayload(state: PluginState) {
  const { unreadEvents, blockingEvents, nextAction } = collectStatusSummary(state)
  return {
    pluginLoaded: true,
    connected: state.connectionStatus === "connected",
    readiness: state.connectionStatus === "connected" ? (nextAction ? "action_required" : "ready") : "degraded",
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
    blockingSummary: countBlockingEvents(blockingEvents),
  }
}

function collectStatusSummary(state: PluginState) {
  const unreadEvents = Array.from(state.inbox.values()).filter((event) => !event.read)
  const blockingEvents = unreadEvents.filter((event) => event.blocking)
  return { unreadEvents, blockingEvents, nextAction: buildNextAction(state, blockingEvents) }
}

function countBlockingEvents(blockingEvents: InboxEvent[]): BlockingSummary {
  const summary: BlockingSummary = {
    total: blockingEvents.length,
    permissionRequests: 0,
    blockedWorkers: 0,
    bySuggestedTool: {},
  }
  for (const event of blockingEvents) {
    countSuggestedTool(summary, event)
    countBlockingKind(summary, event)
  }
  return summary
}

function countSuggestedTool(summary: BlockingSummary, event: InboxEvent): void {
  const suggestedTool = event.metadata?.suggestedTool
  if (typeof suggestedTool === "string")
    summary.bySuggestedTool[suggestedTool] = (summary.bySuggestedTool[suggestedTool] ?? 0) + 1
}

function countBlockingKind(summary: BlockingSummary, event: InboxEvent): void {
  const actionKind = event.metadata?.actionKind as string | undefined
  if (actionKind === "permission" || event.kind === "permission.requested") summary.permissionRequests++
  if (actionKind === "worker-question" || event.kind === "agent.attention") summary.blockedWorkers++
}
