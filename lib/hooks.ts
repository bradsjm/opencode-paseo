import type { Event } from "@opencode-ai/sdk"
import type { PluginState, InboxEvent } from "./state/types.js"
import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import type { PaseoClient } from "./transport/client.js"
import type { Config } from "@opencode-ai/plugin"
import { insertInboxEvent, markEventRead, upsertWorker } from "./state/state.js"
import { mapDaemonWorkerStatus } from "./state/status.js"

function syncWorkerFromPayload(
    state: PluginState,
    type: string,
    payload: Record<string, unknown>,
): void {
    const workerId = payload.workerId as string | undefined
    if (!workerId) return

    const current = state.workers.get(workerId)
    const agent = payload.agent as Record<string, unknown> | undefined
    const rawLabels = agent?.labels
    const labels = Array.isArray(rawLabels)
        ? rawLabels.filter((label): label is string => typeof label === "string")
        : rawLabels && typeof rawLabels === "object"
          ? Object.keys(rawLabels)
          : (current?.labels ?? [])

    const fallbackStatus =
        type === "worker.finished"
            ? "finished"
            : type === "worker.failed"
              ? "failed"
              : type === "worker.blocked"
                ? "blocked"
                : "running"
    const agentStatus =
        typeof agent?.status === "string"
            ? mapDaemonWorkerStatus({
                  status: agent.status,
                  requiresAttention: agent.requiresAttention as boolean | undefined,
                  attentionReason: agent.attentionReason as string | null | undefined,
                  pendingPermissions: Array.isArray(agent.pendingPermissions)
                      ? agent.pendingPermissions
                      : undefined,
              })
            : fallbackStatus === "running"
              ? (current?.status ?? fallbackStatus)
              : fallbackStatus

    upsertWorker(state, {
        id: workerId,
        title:
            (typeof agent?.title === "string" && agent.title) ||
            (typeof agent?.model === "string" && agent.model) ||
            current?.title ||
            workerId,
        agent:
            (typeof agent?.provider === "string" && agent.provider) || current?.agent || "unknown",
        status: agentStatus,
        cwd: (typeof agent?.cwd === "string" && agent.cwd) || current?.cwd || "",
        labels,
        worktreePath:
            (typeof agent?.worktreePath === "string" && agent.worktreePath) ||
            current?.worktreePath,
        branchName:
            (typeof agent?.branchName === "string" && agent.branchName) || current?.branchName,
        unreadEventCount: current?.unreadEventCount ?? 0,
        pendingPermissionIds: current?.pendingPermissionIds ?? [],
    })
}

// ─── Event Handler Factory ───────────────────────────────────────────────────

export function createEventHandler(
    state: PluginState,
    client: PaseoClient,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: { event: Event }) => {
        const event = input.event

        // Process opencode events (e.g., session lifecycle)
        if (event.type === "session.deleted") {
            const sessionId = event.properties.info.id
            if (sessionId) {
                state.sessions.delete(sessionId)
                logger.info("Session removed", { sessionId })
            }
        }
    }
}

// ─── Daemon Event Handler ────────────────────────────────────────────────────
// Processes live events from the Paseo daemon and inserts them into the inbox.

export function createDaemonEventHandler(state: PluginState, logger: Logger, config: PluginConfig) {
    return (daemonEvent: { type: string; payload: Record<string, unknown> }) => {
        const { type, payload } = daemonEvent

        const resourceId = (payload.workerId ||
            payload.terminalId ||
            payload.id ||
            "unknown") as string
        const summary = (payload.summary ||
            payload.message ||
            `${type} for ${resourceId}`) as string

        // Handle daemon connection lifecycle events
        if (type === "daemon.disconnected") {
            state.connectionStatus = "error"
            state.lastError = "Daemon disconnected"
            logger.warn("Daemon disconnected")
            return
        }
        if (type === "daemon.connected") {
            state.connectionStatus = "connected"
            state.lastError = undefined
            logger.info("Daemon reconnected")
            return
        }

        // Map daemon event types to inbox event kinds
        const kindMap: Record<string, InboxEvent["kind"]> = {
            "worker.started": "worker.started",
            "worker.finished": "worker.finished",
            "worker.failed": "worker.failed",
            "worker.blocked": "worker.blocked",
            "terminal.exited": "terminal.exited",
            "terminal.error": "terminal.error",
            "permission.requested": "permission.requested",
            "permission.resolved": "permission.resolved",
        }

        const kind = kindMap[type]
        if (!kind) {
            logger.debug("Ignoring unknown daemon event type", { type })
            return
        }

        if (type.startsWith("worker.")) {
            syncWorkerFromPayload(state, type, payload)
        }

        const blocking =
            kind === "worker.blocked" ||
            kind === "permission.requested" ||
            kind === "terminal.error"

        const event: InboxEvent = {
            id: `evt-${state.eventCounter + 1}-${type}-${resourceId}`,
            kind,
            resourceId,
            blocking,
            summary,
            read: false,
            timestamp: Date.now(),
            metadata: payload,
        }

        const inserted = insertInboxEvent(state, event)
        if (inserted) {
            logger.info("Inbox event inserted", { kind, resourceId, blocking })

            // Handle permission resolution — mark the original request as read
            if (kind === "permission.resolved") {
                const permId = payload.permissionId as string
                if (permId) {
                    // Mark hydration-seeded permission event
                    markEventRead(state, `hydration-perm-${permId}`)
                }
                // Also mark any live permission.requested event for the same resource
                for (const [id, evt] of state.inbox) {
                    if (
                        evt.kind === "permission.requested" &&
                        evt.resourceId === resourceId &&
                        !evt.read
                    ) {
                        markEventRead(state, id)
                    }
                }
            }
        }
    }
}

// ─── Config Handler Factory ──────────────────────────────────────────────────

export function createConfigHandler(config: PluginConfig, logger: Logger) {
    return async (opencodeConfig: Config) => {
        // Register Paseo plugin config section in opencode's config
        logger.debug("Config hook invoked")
    }
}
