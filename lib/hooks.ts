import type { Event } from "@opencode-ai/sdk"
import type { PluginState, InboxEvent, WorkerSummary } from "./state/types.js"
import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import type { PaseoTransport, AgentSummary } from "./transport/types.js"
import type { Config } from "@opencode-ai/plugin"
import {
    insertInboxEvent,
    markEventRead,
    upsertWorker,
    mapAgentToWorkerSummary,
    removeSession,
    buildBlockingMetadata,
} from "./state/state.js"
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

    // Build a merged AgentSummary from event data + current state, then
    // pass through the shared mapper for consistency.
    const merged: AgentSummary = {
        id: workerId,
        provider:
            (typeof agent?.provider === "string" && agent.provider) ||
            current?.provider ||
            "unknown",
        cwd: (typeof agent?.cwd === "string" && agent.cwd) || current?.cwd || "",
        model: (typeof agent?.model === "string" && agent.model) || current?.model || null,
        status:
            typeof agent?.status === "string"
                ? (agent.status as string)
                : (current?.status ?? "unknown"),
        title: (typeof agent?.title === "string" && agent.title) || current?.title || null,
        labels: (agent?.labels as Record<string, string>) ?? current?.labels ?? {},
        requiresAttention: agent?.requiresAttention as boolean | undefined,
        attentionReason: (agent?.attentionReason as string | null) ?? undefined,
        pendingPermissions:
            (agent?.pendingPermissions as Array<Record<string, unknown>>) ??
            current?.pendingPermissions ??
            [],
        capabilities: (agent?.capabilities as Record<string, unknown>) ?? undefined,
        runtimeInfo:
            (agent?.runtimeInfo as Record<string, unknown>) ?? current?.runtimeInfo ?? undefined,
        worktreePath:
            (typeof agent?.worktreePath === "string" && agent.worktreePath) ||
            current?.worktreePath,
        branchName:
            (typeof agent?.branchName === "string" && agent.branchName) || current?.branchName,
        createdAt: (agent?.createdAt as string) ?? current?.createdAt,
        updatedAt: (agent?.updatedAt as string) ?? current?.updatedAt,
    }

    const worker = mapAgentToWorkerSummary(merged)

    // Preserve unread count from current state
    worker.unreadEventCount = current?.unreadEventCount ?? 0

    // Apply event-type-driven status overrides when agent snapshot lacks status
    if (!agent?.status) {
        if (type === "worker.finished") worker.status = "finished"
        else if (type === "worker.failed") worker.status = "failed"
        else if (type === "worker.blocked") worker.status = "blocked"
    }

    upsertWorker(state, worker)
}

// ─── Event Handler Factory ───────────────────────────────────────────────────

export function createEventHandler(
    state: PluginState,
    _client: PaseoTransport,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: { event: Event }) => {
        const event = input.event

        // Process opencode events (e.g., session lifecycle)
        if (event.type === "session.deleted") {
            const sessionId = event.properties.info.id
            if (sessionId) {
                const removed = removeSession(state, sessionId)
                if (removed) {
                    logger.info("Session removed", { sessionId })
                }
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

        // Track pending permissions on the worker
        if (type === "permission.requested") {
            const permId = payload.permissionId as string | undefined
            const worker = state.workers.get(resourceId)
            if (worker && permId && !worker.pendingPermissionIds.includes(permId)) {
                worker.pendingPermissionIds = [...worker.pendingPermissionIds, permId]
                const request = payload.request as Record<string, unknown> | undefined
                if (request) {
                    worker.pendingPermissions = [...worker.pendingPermissions, request]
                }
            }
        }

        const blocking =
            kind === "worker.blocked" ||
            kind === "permission.requested" ||
            kind === "terminal.error"

        // Enrich blocking events with controller-actionable metadata
        const actionMetadata = blocking
            ? buildBlockingMetadata(kind, resourceId, {
                  permissionId: payload.permissionId as string | undefined,
              })
            : {}

        const event: InboxEvent = {
            id: `evt-${state.eventCounter + 1}-${type}-${resourceId}`,
            kind,
            resourceId,
            blocking,
            summary,
            read: false,
            timestamp: Date.now(),
            metadata: { ...payload, ...actionMetadata },
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
                // Remove resolved permission from worker's pending list
                const worker = state.workers.get(resourceId)
                if (worker && permId) {
                    worker.pendingPermissionIds = worker.pendingPermissionIds.filter(
                        (id) => id !== permId,
                    )
                    worker.pendingPermissions = worker.pendingPermissions.filter(
                        (p) => p.id !== permId,
                    )
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
