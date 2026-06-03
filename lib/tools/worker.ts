import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
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
    getOrCreateSession,
    recordCreatedWorker,
    upsertWorker,
    mapAgentToWorkerSummary,
    unbindWorkerFromSessions,
    getBlockingAction,
} from "../state/state.js"

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
                const agents = await client.fetchAgents(undefined)
                for (const a of agents) {
                    const worker = mapAgentToWorkerSummary(a)
                    const existing = state.workers.get(a.id)
                    if (existing) {
                        worker.unreadEventCount = existing.unreadEventCount
                    }
                    upsertWorker(state, worker)
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
    state: PluginState,
    client: PaseoTransport,
    opencodeClient: OpencodeClient,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Create a new Paseo worker (agent) using an OpenCode profile. " +
            `Profiles define the model and mode for the worker. Use paseo_profile_list to see available profiles. ` +
            `Defaults to the "${DEFAULT_PROFILE}" profile if no profile is specified.`,
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

            const result = await client.createWorker({
                cwd,
                profile: profileName,
                provider: workerFields.provider,
                model: workerFields.model,
                modeId: workerFields.modeId,
                initialPrompt: args.initialPrompt,
                labels: args.labels as Record<string, string> | undefined,
                worktreeName: args.worktreeName,
            })

            // Build WorkerSummary and bind to session
            const worker = mapAgentToWorkerSummary({
                id: result.id,
                provider: result.provider,
                cwd: result.cwd,
                model: result.model,
                status: result.status,
                title: result.title,
                labels: (args.labels ?? {}) as Record<string, string>,
            })

            getOrCreateSession(state, context.sessionID, context.worktree)
            recordCreatedWorker(state, context.sessionID, worker)

            logger.info("Worker created", {
                workerId: result.id,
                sessionId: context.sessionID,
                profile: profileName,
            })

            return {
                title: "Worker Created",
                output: JSON.stringify(
                    {
                        id: result.id,
                        profile: profileName,
                        provider: result.provider,
                        cwd: result.cwd,
                        model: result.model,
                        status: result.status,
                        title: result.title,
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

export function createWorkerWaitTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Wait for a Paseo worker to finish its current task. Blocks up to the specified timeout.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to wait on"),
            timeout: tool.schema
                .number()
                .int()
                .optional()
                .describe(
                    `Maximum time to wait in milliseconds (default: ${DEFAULT_WAIT_TIMEOUT_MS})`,
                ),
        },
        async execute(args) {
            const timeout = args.timeout ?? DEFAULT_WAIT_TIMEOUT_MS
            logger.info("Tool: paseo_worker_wait invoked", {
                workerId: args.workerId,
                timeout,
            })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            const result = await client.waitForWorker(args.workerId, timeout)

            // Update local state with final snapshot if available
            if (result.finalSnapshot) {
                const worker = mapAgentToWorkerSummary(result.finalSnapshot)
                const existing = state.workers.get(args.workerId)
                if (existing) {
                    worker.unreadEventCount = existing.unreadEventCount
                }
                upsertWorker(state, worker)
            }

            return {
                title: `Worker Wait: ${args.workerId}`,
                output: JSON.stringify(
                    {
                        workerId: result.workerId,
                        status: result.status,
                        error: result.error,
                        lastMessage: result.lastMessage,
                        timedOut: result.status === "timeout",
                    },
                    null,
                    2,
                ),
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
            "Cancel a running Paseo worker's current task. " +
            "Set forceKill to true for permanent termination: the worker is removed from " +
            "plugin state and unbound from all sessions. forceKill is destructive and irreversible.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to cancel"),
            forceKill: tool.schema
                .boolean()
                .optional()
                .describe(
                    "If true, permanently terminate the worker and remove it from state. Defaults to false.",
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
                state.workers.delete(args.workerId)
                unbindWorkerFromSessions(state, args.workerId)

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

            const result = await client.archiveWorker(args.workerId)

            // Remove from local state and clean up session bindings
            state.workers.delete(args.workerId)
            unbindWorkerFromSessions(state, args.workerId)

            return {
                title: "Worker Archived",
                output: JSON.stringify(
                    {
                        workerId: result.workerId,
                        archivedAt: result.archivedAt,
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
            "Inspect a Paseo worker. Returns current worker details from fresh daemon-backed data. " +
            "Optionally includes activity timeline when includeActivity is true.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to inspect"),
            includeActivity: tool.schema
                .boolean()
                .optional()
                .describe("If true, include the worker's recent activity timeline"),
            activityLimit: tool.schema
                .number()
                .optional()
                .describe("Maximum number of activity entries to return (default: daemon default)"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_inspect invoked", {
                workerId: args.workerId,
                includeActivity: args.includeActivity,
            })

            let snapshot: Record<string, unknown> | null = null
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
                    cwd: mapped.cwd,
                    provider: mapped.provider,
                    model: mapped.model,
                    currentModeId: mapped.currentModeId,
                    worktreePath: mapped.worktreePath,
                    branchName: mapped.branchName,
                    pendingPermissions: mapped.pendingPermissions,
                    pendingPermissionIds: mapped.pendingPermissionIds,
                    runtimeInfo: mapped.runtimeInfo,
                    persistence: mapped.persistence,
                    createdAt: mapped.createdAt,
                    updatedAt: mapped.updatedAt,
                    project: fetched.project,
                    blockingAction: getBlockingAction(mapped),
                }
            } else if (worker) {
                // Fallback to local state
                snapshot = {
                    id: worker.id,
                    title: worker.title,
                    status: worker.status,
                    cwd: worker.cwd,
                    provider: worker.provider,
                    model: worker.model,
                    currentModeId: worker.currentModeId,
                    worktreePath: worker.worktreePath,
                    branchName: worker.branchName,
                    pendingPermissions: worker.pendingPermissions,
                    pendingPermissionIds: worker.pendingPermissionIds,
                    runtimeInfo: worker.runtimeInfo,
                    persistence: worker.persistence,
                    source: "local-cache",
                    blockingAction: getBlockingAction(worker),
                }
            } else {
                throw new Error(`Worker "${args.workerId}" not found`)
            }

            // Optional activity fetch
            let activity: Record<string, unknown> | null = null
            if (args.includeActivity) {
                const activityResult = await client.fetchWorkerActivity({
                    workerId: args.workerId,
                    limit: args.activityLimit,
                })
                activity = activityResult.timeline
            }

            const output: Record<string, unknown> = { ...snapshot }
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
