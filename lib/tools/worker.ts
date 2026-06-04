import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState, WorkerStatus, WorkerSummary } from "../state/types.js"
import type { PluginConfig } from "../config.js"
import { shouldNudge } from "../notifier.js"
import type { WorkerLaunchQueueController } from "../worker-launch/queue.js"
import type {
    DaemonEvent,
    MultiWorkerWaitResult,
    PaseoTransport,
    WorkerWaitNudgeEvent,
    WorkerWaitResult,
} from "../transport/types.js"
import type { WorkerActivitySummary } from "../transport/types.js"
import type { Logger } from "../logger.js"
import type { OpencodeClient } from "../profile.js"
import {
    listProfiles,
    normalizeProfileName,
    resolveProfile,
    profileToWorkerFields,
    DEFAULT_PROFILE,
} from "../profile.js"
import {
    upsertWorker,
    mapAgentToWorkerSummary,
    removeWorkerFromState,
    getBlockingAction,
} from "../state/state.js"

function isWorkerMissingUpstreamError(err: unknown): err is Error {
    return (
        err instanceof Error &&
        /\b(agent|worker)\b.*\bnot found\b|\bnot found\b.*\b(agent|worker)\b/i.test(err.message)
    )
}

// ─── Worker List Tool ────────────────────────────────────────────────────────

export function createWorkerListTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "List all known Paseo workers. Returns ID, status, cwd, provider/model/mode, and permission data for each worker.",
        args: {},
        async execute() {
            logger.info("Tool: paseo_worker_list invoked")

            // Refresh from daemon
            try {
                const preexistingWorkerIds = new Set(state.workers.keys())
                const agents = await client.fetchAgents(undefined)
                const fetchedWorkerIds = new Set<string>()

                for (const a of agents) {
                    fetchedWorkerIds.add(a.id)
                    const worker = mapAgentToWorkerSummary(a)
                    const existing = state.workers.get(a.id)
                    if (existing) {
                        worker.unreadEventCount = existing.unreadEventCount
                    }
                    upsertWorker(state, worker)
                }

                for (const workerId of preexistingWorkerIds) {
                    if (!fetchedWorkerIds.has(workerId)) {
                        removeWorkerFromState(state, workerId)
                    }
                }
            } catch (err: any) {
                logger.warn("Worker list refresh failed", err.message)
            }

            const workers = Array.from(state.workers.values()).map((w) => ({
                id: w.id,
                title: w.title,
                status: w.status,
                cwd: w.cwd,
                provider: w.provider,
                model: w.model,
                currentModeId: w.currentModeId,
                worktreePath: w.worktreePath,
                branchName: w.branchName,
                pendingPermissionIds: w.pendingPermissionIds,
                pendingPermissionCount: w.pendingPermissions.length,
                unreadEventCount: w.unreadEventCount,
                blockingAction: getBlockingAction(w),
            }))

            return {
                title: "Paseo Workers",
                output: JSON.stringify({ workers, count: workers.length }, null, 2),
            }
        },
    })
}

// ─── Worker Create Tool ──────────────────────────────────────────────────────

export function createWorkerCreateTool(
    opencodeClient: OpencodeClient,
    workerLaunchQueue: WorkerLaunchQueueController,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Queue a new Paseo worker (agent) launch using an OpenCode profile. " +
            `Profiles define the model and mode for the worker. Use paseo_profile_list to see available profiles. ` +
            `Defaults to the "${DEFAULT_PROFILE}" profile if no profile is specified. ` +
            "This tool returns a launch receipt immediately; queued launches are executed FIFO with one active launch per plugin instance. " +
            "Use paseo_worker_launch_status to check launch progress and worker ID once created.",
        args: {
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory for the worker (defaults to session directory)"),
            profile: tool.schema
                .string()
                .optional()
                .describe(
                    `OpenCode profile name to use (default: "${DEFAULT_PROFILE}"). Use paseo_profile_list to see available profiles.`,
                ),
            initialPrompt: tool.schema
                .string()
                .optional()
                .describe("Initial prompt to send to the worker on creation"),
            labels: tool.schema
                .record(tool.schema.string(), tool.schema.string())
                .optional()
                .describe("Key-value labels to attach to the worker"),
            worktreeName: tool.schema
                .string()
                .optional()
                .describe("Name for a git worktree to create for this worker"),
        },
        async execute(args, context: ToolContext) {
            const cwd = args.cwd ?? context.directory
            const profileName = normalizeProfileName(args.profile)

            logger.info("Tool: paseo_worker_create invoked", {
                cwd,
                profile: profileName,
            })

            // Resolve profile into daemon payload fields
            const profiles = await listProfiles(opencodeClient, cwd)
            const profile = resolveProfile(profiles, profileName)
            const workerFields = profileToWorkerFields(profile)

            const receipt = workerLaunchQueue.enqueueWorkerLaunch({
                sessionId: context.sessionID,
                projectRoot: context.worktree ?? context.directory,
                profile: profileName,
                provider: workerFields.provider,
                model: workerFields.model,
                modeId: workerFields.modeId,
                cwd,
                initialPrompt: args.initialPrompt,
                labels: args.labels as Record<string, string> | undefined,
                worktreeName: args.worktreeName,
            })

            void workerLaunchQueue.drainWorkerLaunchQueue()

            logger.info("Worker launch queued", {
                launchId: receipt.launchId,
                sessionId: context.sessionID,
                profile: profileName,
            })

            return {
                title: "Worker Launch Queued",
                output: JSON.stringify(
                    {
                        launchId: receipt.launchId,
                        status: receipt.status,
                        position: receipt.position,
                        profile: receipt.profile,
                        cwd: receipt.cwd,
                        worktreeName: receipt.worktreeName,
                        message:
                            "Worker launch queued. Use paseo_worker_launch_status with the launchId " +
                            "to monitor progress and retrieve the workerId once created.",
                    },
                    null,
                    2,
                ),
            }
        },
    })
}

export function createWorkerLaunchStatusTool(
    workerLaunchQueue: WorkerLaunchQueueController,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Get the status of a queued Paseo worker launch. Returns queued/starting/created/failed state and workerId when available.",
        args: {
            launchId: tool.schema.string().describe("ID of the worker launch to inspect"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_launch_status invoked", { launchId: args.launchId })

            const status = workerLaunchQueue.getWorkerLaunchStatus(args.launchId)

            return {
                title: "Worker Launch Status",
                output: JSON.stringify(
                    {
                        launchId: status.launchId,
                        status: status.status,
                        profile: status.profile,
                        cwd: status.cwd,
                        worktreeName: status.worktreeName,
                        enqueuedAt: status.enqueuedAt,
                        startedAt: status.startedAt,
                        finishedAt: status.finishedAt,
                        ...(status.position !== undefined ? { position: status.position } : {}),
                        ...(status.workerId ? { workerId: status.workerId } : {}),
                        ...(status.error ? { error: status.error } : {}),
                    },
                    null,
                    2,
                ),
            }
        },
    })
}

// ─── Worker Send Tool ────────────────────────────────────────────────────────

export function createWorkerSendTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description: "Send a message to an existing Paseo worker. Does not wait for a response.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to send a message to"),
            message: tool.schema.string().describe("Text message to send to the worker"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_send invoked", {
                workerId: args.workerId,
                messageLength: args.message.length,
            })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            await client.sendWorkerMessage(args.workerId, args.message)

            return {
                title: "Message Sent",
                output: JSON.stringify(
                    {
                        workerId: args.workerId,
                        sent: args.message.length,
                    },
                    null,
                    2,
                ),
            }
        },
    })
}

// ─── Worker Wait Tool ────────────────────────────────────────────────────────

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const WAIT_SLICE_TIMEOUT_MS = 250

type InspectActivityState = "active" | "quiet" | "blocked" | "finished" | "unknown"

type ReadyForDependentWork = boolean | "unknown"

interface WorkerInspectResponse {
    worker: {
        id: string
        title: string
        status: WorkerStatus
        rawStatus: string | null
        provider: string
        model: string | null
        currentModeId: string | null
        cwd: string
        worktreePath?: string
        branchName?: string
        createdAt?: string
        updatedAt?: string
        source: "daemon" | "local-cache"
    }
    attention: {
        pendingPermissionIds: string[]
        pendingPermissionCount: number
        blockingAction: string | null
        requiresAttention: boolean
        attentionReason: string | null
    }
    progress: {
        activityState: InspectActivityState
        summary: string
        lastMeaningfulUpdate: string | null
        readyForDependentWork: ReadyForDependentWork
    }
    activity?: WorkerActivitySummary | null
}

function isTerminalWorkerStatus(status: string | undefined): boolean {
    return status === "finished" || status === "failed" || status === "canceled"
}

function deriveActivityState(
    worker: Pick<WorkerSummary, "status" | "pendingPermissionIds" | "requiresAttention">,
    activity: WorkerActivitySummary | null,
    activityFetched: boolean,
): InspectActivityState {
    if (
        worker.requiresAttention ||
        worker.pendingPermissionIds.length > 0 ||
        worker.status === "blocked"
    ) {
        return "blocked"
    }
    if (isTerminalWorkerStatus(worker.status)) {
        return "finished"
    }
    if (worker.status === "running") {
        if (!activityFetched) {
            return "unknown"
        }
        return activity && activity.entries.length > 0 ? "active" : "quiet"
    }
    return activity && activity.entries.length > 0 ? "active" : "unknown"
}

function deriveReadyForDependentWork(status: string): ReadyForDependentWork {
    if (status === "finished") return true
    if (
        status === "running" ||
        status === "blocked" ||
        status === "failed" ||
        status === "canceled"
    ) {
        return false
    }
    return "unknown"
}

function deriveProgressSummary(
    worker: Pick<
        WorkerSummary,
        "status" | "pendingPermissionIds" | "requiresAttention" | "attentionReason"
    >,
    activityState: InspectActivityState,
    activity: WorkerActivitySummary | null,
    activityFetched: boolean,
): { summary: string; lastMeaningfulUpdate: string | null } {
    const latest = activity?.entries[0]
    if (latest) {
        return {
            summary: latest.summary,
            lastMeaningfulUpdate: latest.timestamp ?? null,
        }
    }
    if (activityState === "blocked") {
        return {
            summary:
                worker.attentionReason ??
                (worker.pendingPermissionIds.length > 0
                    ? "Waiting for permission response"
                    : "Worker needs attention"),
            lastMeaningfulUpdate: null,
        }
    }
    if (activityState === "finished") {
        return {
            summary:
                worker.status === "failed" ? "Worker failed" : "Worker reached a terminal state",
            lastMeaningfulUpdate: null,
        }
    }
    if (activityState === "quiet") {
        return {
            summary: "Worker is running but has no recent projected activity",
            lastMeaningfulUpdate: null,
        }
    }
    if (!activityFetched && worker.status === "running") {
        return {
            summary: "Activity not fetched; worker status is running",
            lastMeaningfulUpdate: null,
        }
    }
    return {
        summary: worker.status === "idle" ? "Worker is idle" : "No recent projected activity",
        lastMeaningfulUpdate: null,
    }
}

function syncWorkerFromFinalSnapshot(state: PluginState, result: WorkerWaitResult): void {
    if (!result.finalSnapshot) {
        return
    }

    const worker = mapAgentToWorkerSummary(result.finalSnapshot)
    const existing = state.workers.get(result.workerId)
    if (existing) {
        worker.unreadEventCount = existing.unreadEventCount
    }
    upsertWorker(state, worker)
}

function getNudgeEventFromDaemonEvent(
    event: DaemonEvent,
    ownedWorkerIds: Set<string>,
    config: PluginConfig,
): WorkerWaitNudgeEvent | null {
    switch (event.type) {
        case "worker.finished":
        case "worker.failed":
        case "worker.blocked":
        case "permission.requested": {
            const workerId = event.payload.workerId
            if (!ownedWorkerIds.has(workerId) || !shouldNudge(event.type, config.notifications)) {
                return null
            }

            const summary =
                (typeof event.payload.summary === "string" && event.payload.summary) ||
                (typeof event.payload.message === "string" && event.payload.message) ||
                `${event.type} for ${workerId}`

            return { kind: event.type, workerId, summary }
        }
        default:
            return null
    }
}

function getExistingUnreadNudge(
    state: PluginState,
    sessionId: string,
    config: PluginConfig,
): WorkerWaitNudgeEvent | null {
    const session = state.sessions.get(sessionId)
    if (!session) {
        return null
    }

    for (const inboxEvent of session.unreadEvents.values()) {
        if (!session.createdWorkerIds.has(inboxEvent.resourceId)) {
            continue
        }
        if (
            (inboxEvent.kind === "worker.finished" ||
                inboxEvent.kind === "worker.failed" ||
                inboxEvent.kind === "worker.blocked" ||
                inboxEvent.kind === "permission.requested") &&
            shouldNudge(inboxEvent.kind, config.notifications)
        ) {
            return {
                kind: inboxEvent.kind,
                workerId: inboxEvent.resourceId,
                summary: inboxEvent.summary,
            }
        }
    }

    return null
}

export function createWorkerWaitTool(
    state: PluginState,
    client: PaseoTransport,
    config: PluginConfig,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Wait for one or more Paseo workers to finish their current tasks. Supports waiting for any or all targets, respects a global timeout, and stops early if this session receives a nudge-eligible owned-worker event.",
        args: {
            workerIds: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("IDs of one or more workers to wait on"),
            waitFor: tool.schema
                .enum(["any", "all"])
                .optional()
                .describe(
                    'Wait mode: "any" returns after the first target completes; "all" waits for every target. Defaults to "all".',
                ),
            timeout: tool.schema
                .number()
                .int()
                .optional()
                .describe(
                    `Maximum time to wait in milliseconds (default: ${DEFAULT_WAIT_TIMEOUT_MS})`,
                ),
        },
        async execute(args, context: ToolContext) {
            const timeout = args.timeout ?? DEFAULT_WAIT_TIMEOUT_MS
            const waitFor = args.waitFor ?? "all"
            const workerIds = Array.from(
                new Set(args.workerIds.map((id) => id.trim()).filter(Boolean)),
            )
            logger.info("Tool: paseo_worker_wait invoked", {
                workerIds,
                waitFor,
                sessionId: context.sessionID,
                timeout,
            })

            if (workerIds.length === 0) {
                throw new Error("workerIds must contain at least one non-empty worker ID")
            }

            for (const workerId of workerIds) {
                if (!state.workers.get(workerId)) {
                    throw new Error(`Worker "${workerId}" not found in local state`)
                }
            }

            const session = state.sessions.get(context.sessionID)
            const ownedWorkerIds = session?.createdWorkerIds ?? new Set<string>()

            let pendingWorkerIds = [...workerIds]
            const completedResults = new Map<string, WorkerWaitResult>()
            let interruptedByNudge = false
            let nudgeEvent: WorkerWaitNudgeEvent | undefined
            let unsubscribe = () => {}

            const buildPayload = (timedOut: boolean): MultiWorkerWaitResult => ({
                waitFor,
                workerIds,
                results: workerIds
                    .filter((workerId) => completedResults.has(workerId))
                    .map((workerId) => completedResults.get(workerId)!),
                pendingWorkerIds,
                interruptedByNudge,
                nudgeEvent,
                timedOut,
            })

            try {
                unsubscribe = client.onEvent((event) => {
                    if (nudgeEvent) {
                        return
                    }
                    const matched = getNudgeEventFromDaemonEvent(event, ownedWorkerIds, config)
                    if (matched) {
                        interruptedByNudge = true
                        nudgeEvent = matched
                    }
                })

                nudgeEvent = getExistingUnreadNudge(state, context.sessionID, config) ?? undefined
                if (nudgeEvent) {
                    interruptedByNudge = true
                    return {
                        title: "Worker Wait",
                        output: JSON.stringify(buildPayload(false), null, 2),
                    }
                }

                const deadline = Date.now() + timeout

                while (pendingWorkerIds.length > 0) {
                    if (nudgeEvent) {
                        interruptedByNudge = true
                        return {
                            title: "Worker Wait",
                            output: JSON.stringify(buildPayload(false), null, 2),
                        }
                    }

                    const remaining = deadline - Date.now()
                    if (remaining <= 0) {
                        return {
                            title: "Worker Wait",
                            output: JSON.stringify(buildPayload(true), null, 2),
                        }
                    }

                    const sliceTimeout = Math.min(WAIT_SLICE_TIMEOUT_MS, remaining)
                    const sliceWorkerIds = [...pendingWorkerIds]
                    const settled = await Promise.allSettled(
                        sliceWorkerIds.map((workerId) =>
                            client.waitForWorker(workerId, sliceTimeout),
                        ),
                    )

                    for (const [index, settledResult] of settled.entries()) {
                        if (settledResult.status === "rejected") {
                            throw settledResult.reason
                        }

                        const result = settledResult.value
                        syncWorkerFromFinalSnapshot(state, result)
                        if (result.status === "timeout") {
                            continue
                        }

                        completedResults.set(result.workerId, result)
                    }

                    pendingWorkerIds = pendingWorkerIds.filter(
                        (workerId) => !completedResults.has(workerId),
                    )

                    if (waitFor === "any" && completedResults.size > 0) {
                        return {
                            title: "Worker Wait",
                            output: JSON.stringify(buildPayload(false), null, 2),
                        }
                    }

                    if (waitFor === "all" && pendingWorkerIds.length === 0) {
                        return {
                            title: "Worker Wait",
                            output: JSON.stringify(buildPayload(false), null, 2),
                        }
                    }

                    const unreadNudge = getExistingUnreadNudge(state, context.sessionID, config)
                    if (unreadNudge && !nudgeEvent) {
                        interruptedByNudge = true
                        nudgeEvent = unreadNudge
                    }
                }

                return {
                    title: "Worker Wait",
                    output: JSON.stringify(buildPayload(false), null, 2),
                }
            } finally {
                unsubscribe()
            }
        },
    })
}

// ─── Worker Cancel Tool ──────────────────────────────────────────────────────

export function createWorkerCancelTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Cancel a running Paseo worker's current task. Before using forceKill=true, capture " +
            "any important output or status first, because it may not remain available after " +
            "permanent termination. Set forceKill to true for permanent termination: the worker " +
            "is removed from plugin state and unbound from all sessions. forceKill is destructive " +
            "and irreversible.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to cancel"),
            forceKill: tool.schema
                .boolean()
                .optional()
                .describe(
                    "If true, permanently terminate the worker and remove it from state. " +
                        "Destructive and irreversible; capture any needed output or status first. " +
                        "Defaults to false.",
                ),
        },
        async execute(args) {
            const isKill = args.forceKill === true
            logger.info("Tool: paseo_worker_cancel invoked", {
                workerId: args.workerId,
                forceKill: isKill,
            })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            if (isKill) {
                await client.killWorker(args.workerId)

                // Permanent removal: delete from state and unbind sessions
                removeWorkerFromState(state, args.workerId)

                return {
                    title: "Worker Killed",
                    output: JSON.stringify(
                        {
                            workerId: args.workerId,
                            action: "killed",
                            warning:
                                "Worker was permanently terminated and removed from plugin state.",
                        },
                        null,
                        2,
                    ),
                }
            }

            await client.cancelWorker(args.workerId)

            // Update local state
            worker.status = "canceled"

            return {
                title: "Worker Canceled",
                output: JSON.stringify(
                    {
                        workerId: args.workerId,
                        action: "canceled",
                        status: "canceled",
                    },
                    null,
                    2,
                ),
            }
        },
    })
}

// ─── Worker Archive Tool ─────────────────────────────────────────────────────

export function createWorkerArchiveTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description: "Archive a Paseo worker. The worker is removed from the active list.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to archive"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_archive invoked", { workerId: args.workerId })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            let archivedAt: string | null = null
            let alreadyRemovedUpstream = false

            try {
                const result = await client.archiveWorker(args.workerId)
                archivedAt = result.archivedAt
            } catch (err: unknown) {
                if (!isWorkerMissingUpstreamError(err)) {
                    throw err
                }
                alreadyRemovedUpstream = true
            }

            // Remove from local state and clean up session bindings
            removeWorkerFromState(state, args.workerId)

            return {
                title: "Worker Archived",
                output: JSON.stringify(
                    {
                        workerId: args.workerId,
                        archivedAt,
                        alreadyRemovedUpstream,
                    },
                    null,
                    2,
                ),
            }
        },
    })
}

// ─── Worker Update Tool ──────────────────────────────────────────────────────

export function createWorkerUpdateTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Update a Paseo worker's metadata and runtime settings. " +
            "Supports name, labels, and settings (modeId, model, thinkingOptionId, features). " +
            "Pass null for model or thinkingOptionId to clear them.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to update"),
            name: tool.schema.string().optional().describe("New display name for the worker"),
            labels: tool.schema
                .record(tool.schema.string(), tool.schema.string())
                .optional()
                .describe("Replacement label map"),
            settings: tool.schema
                .object({
                    modeId: tool.schema
                        .string()
                        .optional()
                        .describe("Mode to switch the worker to"),
                    model: tool.schema
                        .string()
                        .nullable()
                        .optional()
                        .describe("Model ID to set, or null to clear"),
                    thinkingOptionId: tool.schema
                        .string()
                        .nullable()
                        .optional()
                        .describe("Thinking option ID to set, or null to clear"),
                    features: tool.schema
                        .record(tool.schema.string(), tool.schema.unknown())
                        .optional()
                        .describe("Map of feature ID to value"),
                })
                .optional()
                .describe("Runtime settings to apply"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_update invoked", { workerId: args.workerId })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            const result = await client.updateWorker({
                workerId: args.workerId,
                name: args.name,
                labels: args.labels,
                settings: args.settings,
            })

            // Refresh local state from daemon if update succeeded
            if (result.updated) {
                const fetched = await client.fetchWorker(args.workerId)
                if (fetched) {
                    const refreshed = mapAgentToWorkerSummary(fetched.agent)
                    refreshed.unreadEventCount = worker.unreadEventCount
                    upsertWorker(state, refreshed)
                }
            }

            return {
                title: "Worker Updated",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Worker Inspect Tool ─────────────────────────────────────────────────────

export function createWorkerInspectTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Inspect a Paseo worker. Returns a compact daemon-backed summary for routing, attention, and progress decisions. " +
            "Optionally includes a projected recent activity summary when includeActivity is true.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to inspect"),
            includeActivity: tool.schema
                .boolean()
                .optional()
                .describe("If true, include the worker's recent projected activity summary"),
            activityLimit: tool.schema
                .number()
                .optional()
                .describe("Maximum number of projected activity entries to return"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_inspect invoked", {
                workerId: args.workerId,
                includeActivity: args.includeActivity,
            })

            let snapshot: WorkerInspectResponse["worker"] | null = null
            let worker = state.workers.get(args.workerId)

            // Try fresh daemon fetch first
            const fetched = await client.fetchWorker(args.workerId)
            if (fetched) {
                const mapped = mapAgentToWorkerSummary(fetched.agent)
                const existing = state.workers.get(args.workerId)
                if (existing) {
                    mapped.unreadEventCount = existing.unreadEventCount
                }
                upsertWorker(state, mapped)
                worker = mapped

                snapshot = {
                    id: mapped.id,
                    title: mapped.title,
                    status: mapped.status,
                    rawStatus: mapped.rawStatus ?? fetched.agent.status ?? null,
                    cwd: mapped.cwd,
                    provider: mapped.provider,
                    model: mapped.model,
                    currentModeId: mapped.currentModeId,
                    worktreePath: mapped.worktreePath,
                    branchName: mapped.branchName,
                    createdAt: mapped.createdAt,
                    updatedAt: mapped.updatedAt,
                    source: "daemon",
                }
            } else if (worker) {
                // Fallback to local state
                snapshot = {
                    id: worker.id,
                    title: worker.title,
                    status: worker.status,
                    rawStatus: worker.rawStatus ?? null,
                    cwd: worker.cwd,
                    provider: worker.provider,
                    model: worker.model,
                    currentModeId: worker.currentModeId,
                    worktreePath: worker.worktreePath,
                    branchName: worker.branchName,
                    createdAt: worker.createdAt,
                    updatedAt: worker.updatedAt,
                    source: "local-cache",
                }
            } else {
                throw new Error(`Worker "${args.workerId}" not found`)
            }

            // Optional activity fetch
            let activity: WorkerActivitySummary | null = null
            const activityFetched = Boolean(args.includeActivity)
            if (activityFetched) {
                const activityResult = await client.fetchWorkerActivity({
                    workerId: args.workerId,
                    limit: args.activityLimit,
                })
                activity = activityResult.activity
            }

            const activityState = deriveActivityState(worker, activity, activityFetched)
            const progress = deriveProgressSummary(worker, activityState, activity, activityFetched)
            const output: WorkerInspectResponse = {
                worker: snapshot,
                attention: {
                    pendingPermissionIds: worker.pendingPermissionIds,
                    pendingPermissionCount: worker.pendingPermissions.length,
                    blockingAction: getBlockingAction(worker),
                    requiresAttention: worker.requiresAttention,
                    attentionReason: worker.attentionReason,
                },
                progress: {
                    activityState,
                    summary: progress.summary,
                    lastMeaningfulUpdate: progress.lastMeaningfulUpdate,
                    readyForDependentWork: deriveReadyForDependentWork(worker.status),
                },
            }
            if (args.includeActivity) {
                output.activity = activity
            }

            return {
                title: `Worker Inspect: ${args.workerId}`,
                output: JSON.stringify(output, null, 2),
            }
        },
    })
}
