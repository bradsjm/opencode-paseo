import type { PluginConfig } from "../config.js"
import { getHydrationPermissionEventId } from "../inbox/ids.js"
import { truncateSummary } from "../inbox/summary.js"
import type { Logger } from "../logger.js"
import { shouldNudge, formatNudgeMessage, sendNudge } from "../notifier.js"
import {
    buildBlockingMetadata,
    findSessionsForResource,
    insertInboxEvent,
    markEventRead,
    mapAgentToWorkerSummary,
    setConnectionStatus,
    upsertWorker,
} from "../state/state.js"
import type { InboxEvent, PluginState } from "../state/types.js"
import type {
    AgentSummary,
    DaemonEvent,
    PermissionRequestedEvent,
    PermissionResolvedEvent,
    WorkerBlockedEvent,
    WorkerEventPayload,
    WorkerFailedEvent,
    WorkerFinishedEvent,
    WorkerStartedEvent,
} from "../transport/types.js"
import type { OpencodeClient } from "../profile.js"

function syncWorkerFromPayload(
    state: PluginState,
    type:
        | WorkerStartedEvent["type"]
        | WorkerFinishedEvent["type"]
        | WorkerFailedEvent["type"]
        | WorkerBlockedEvent["type"],
    payload: WorkerEventPayload,
): void {
    const workerId = payload.workerId
    const current = state.workers.get(workerId)
    const agent = payload.agent as Record<string, unknown> | undefined

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
    worker.unreadEventCount = current?.unreadEventCount ?? 0

    if (!agent?.status) {
        if (type === "worker.finished") worker.status = "finished"
        else if (type === "worker.failed") worker.status = "failed"
        else if (type === "worker.blocked") worker.status = "blocked"
    }

    upsertWorker(state, worker)
}

function getWorkerEventSummary(
    type: DaemonEvent["type"],
    resourceId: string,
    payload: Record<string, unknown>,
): string {
    const rawSummary =
        (typeof payload.summary === "string" && payload.summary) ||
        (typeof payload.message === "string" && payload.message) ||
        (type === "daemon.connected"
            ? "Daemon connected"
            : type === "daemon.disconnected"
              ? "Daemon disconnected"
              : `${type} for ${resourceId}`)

    return rawSummary
}

function createInboxEvent(
    state: PluginState,
    kind: InboxEvent["kind"],
    resourceId: string,
    summary: string,
    metadata: Record<string, unknown> | undefined,
): InboxEvent {
    return {
        id: `evt-${state.eventCounter + 1}-${kind}-${resourceId}`,
        kind,
        resourceId,
        blocking: kind === "worker.blocked" || kind === "permission.requested",
        summary,
        read: false,
        timestamp: Date.now(),
        metadata,
    }
}

function assertNever(value: never): never {
    throw new Error(`Unhandled daemon event: ${JSON.stringify(value)}`)
}

function handlePermissionRequested(state: PluginState, event: PermissionRequestedEvent): void {
    const worker = state.workers.get(event.payload.workerId)
    const permId = event.payload.permissionId
    if (!worker || !permId || worker.pendingPermissionIds.includes(permId)) {
        return
    }

    worker.pendingPermissionIds = [...worker.pendingPermissionIds, permId]
    worker.pendingPermissions = [...worker.pendingPermissions, event.payload.request]
}

function handlePermissionResolved(state: PluginState, event: PermissionResolvedEvent): void {
    const permId = event.payload.permissionId
    markEventRead(state, getHydrationPermissionEventId(permId))

    for (const [id, inboxEvent] of state.inbox) {
        if (
            inboxEvent.kind === "permission.requested" &&
            inboxEvent.resourceId === event.payload.workerId &&
            !inboxEvent.read
        ) {
            markEventRead(state, id)
        }
    }

    const worker = state.workers.get(event.payload.workerId)
    if (!worker) {
        return
    }

    worker.pendingPermissionIds = worker.pendingPermissionIds.filter((id) => id !== permId)
    worker.pendingPermissions = worker.pendingPermissions.filter(
        (permission) => permission.id !== permId,
    )
}

export function createDaemonEventHandler(
    state: PluginState,
    logger: Logger,
    config: PluginConfig,
    opencodeClient?: OpencodeClient,
) {
    return (daemonEvent: DaemonEvent) => {
        let inboxEvent: InboxEvent | null = null

        switch (daemonEvent.type) {
            case "daemon.connected": {
                setConnectionStatus(state, "connected")
                logger.info("Daemon connected")
                const summary = truncateSummary("Daemon connected", config.output.maxSummaryLength)
                inboxEvent = createInboxEvent(state, daemonEvent.type, "daemon", summary, undefined)
                break
            }

            case "daemon.disconnected": {
                setConnectionStatus(state, "error", "Daemon disconnected")
                logger.warn("Daemon disconnected")
                const summary = truncateSummary(
                    "Daemon disconnected",
                    config.output.maxSummaryLength,
                )
                inboxEvent = createInboxEvent(state, daemonEvent.type, "daemon", summary, undefined)
                break
            }

            case "daemon.error": {
                setConnectionStatus(state, "error", daemonEvent.payload.message)
                logger.error("Daemon error event", { message: daemonEvent.payload.message })
                break
            }

            case "worker.started":
            case "worker.finished":
            case "worker.failed":
            case "worker.blocked": {
                syncWorkerFromPayload(state, daemonEvent.type, daemonEvent.payload)
                const resourceId = daemonEvent.payload.workerId
                const summary = truncateSummary(
                    getWorkerEventSummary(daemonEvent.type, resourceId, daemonEvent.payload),
                    config.output.maxSummaryLength,
                )
                const metadata =
                    daemonEvent.type === "worker.blocked"
                        ? {
                              ...daemonEvent.payload,
                              ...buildBlockingMetadata("worker.blocked", resourceId),
                          }
                        : daemonEvent.payload
                inboxEvent = createInboxEvent(
                    state,
                    daemonEvent.type,
                    resourceId,
                    summary,
                    metadata,
                )
                break
            }

            case "permission.requested": {
                handlePermissionRequested(state, daemonEvent)
                const resourceId = daemonEvent.payload.workerId
                const summary = truncateSummary(
                    getWorkerEventSummary(daemonEvent.type, resourceId, daemonEvent.payload),
                    config.output.maxSummaryLength,
                )
                inboxEvent = createInboxEvent(state, daemonEvent.type, resourceId, summary, {
                    ...daemonEvent.payload,
                    ...buildBlockingMetadata("permission.requested", resourceId, {
                        permissionId: daemonEvent.payload.permissionId,
                    }),
                })
                break
            }

            case "permission.resolved": {
                handlePermissionResolved(state, daemonEvent)
                const resourceId = daemonEvent.payload.workerId
                const summary = truncateSummary(
                    getWorkerEventSummary(daemonEvent.type, resourceId, daemonEvent.payload),
                    config.output.maxSummaryLength,
                )
                inboxEvent = createInboxEvent(
                    state,
                    daemonEvent.type,
                    resourceId,
                    summary,
                    daemonEvent.payload,
                )
                break
            }

            default:
                assertNever(daemonEvent)
        }

        if (!inboxEvent) {
            return
        }

        const inserted = insertInboxEvent(state, inboxEvent, config.output.maxInboxItems)
        if (!inserted) {
            return
        }

        logger.info("Inbox event inserted", {
            kind: inboxEvent.kind,
            resourceId: inboxEvent.resourceId,
            blocking: inboxEvent.blocking,
        })

        if (opencodeClient && shouldNudge(inboxEvent.kind, config.notifications)) {
            const sessionIds = findSessionsForResource(state, inboxEvent.resourceId)
            if (sessionIds.length > 0) {
                const message = formatNudgeMessage(
                    inboxEvent.kind,
                    inboxEvent.resourceId,
                    inboxEvent.summary,
                )
                sendNudge(opencodeClient, sessionIds, message, logger)
            }
        }
    }
}
