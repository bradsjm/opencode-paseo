import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import {
    getOrCreateSession,
    recordCreatedWorker,
    upsertWorker,
    mapAgentToWorkerSummary,
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
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Create a new Paseo worker (agent). Validates the provider against the current provider snapshot for the target cwd before creation. Model and modeId are passed through to the daemon for validation.",
        args: {
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory for the worker (defaults to session directory)"),
            provider: tool.schema
                .string()
                .optional()
                .describe("Provider ID to use (validated against daemon provider snapshot)"),
            model: tool.schema
                .string()
                .optional()
                .describe("Model ID to use (validated against daemon provider snapshot)"),
            modeId: tool.schema
                .string()
                .optional()
                .describe("Mode ID to use (validated against daemon provider snapshot)"),
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
            logger.info("Tool: paseo_worker_create invoked", {
                cwd,
                provider: args.provider,
                model: args.model,
            })

            // Validate provider against current snapshot
            if (args.provider || args.model || args.modeId) {
                try {
                    const providers = await client.getProvidersSnapshot(cwd)
                    if (args.provider) {
                        const found = providers.some(
                            (p) => p.id === args.provider || p.provider === args.provider,
                        )
                        if (!found) {
                            const available = providers
                                .map((p) => p.id || p.provider)
                                .filter(Boolean)
                                .join(", ")
                            throw new Error(
                                `Provider "${args.provider}" not found in daemon provider snapshot for cwd "${cwd}". Available providers: ${available || "(none)"}`,
                            )
                        }
                    }
                } catch (err: any) {
                    if (err.message?.includes("not found in daemon provider snapshot")) {
                        throw err
                    }
                    logger.warn(
                        "Provider validation skipped due to snapshot fetch failure",
                        err.message,
                    )
                }
            }

            const result = await client.createWorker({
                cwd,
                provider: args.provider,
                model: args.model,
                modeId: args.modeId,
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
            })

            return {
                title: "Worker Created",
                output: JSON.stringify(
                    {
                        id: result.id,
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
        description: "Cancel a running Paseo worker's current task.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to cancel"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_cancel invoked", { workerId: args.workerId })

            // Verify worker exists in local state
            const worker = state.workers.get(args.workerId)
            if (!worker) {
                throw new Error(`Worker "${args.workerId}" not found in local state`)
            }

            await client.cancelWorker(args.workerId)

            // Update local state
            worker.status = "canceled"

            return {
                title: "Worker Canceled",
                output: JSON.stringify(
                    {
                        workerId: args.workerId,
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
            for (const session of state.sessions.values()) {
                session.createdWorkerIds.delete(args.workerId)
            }

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

// ─── Worker Inspect Tool ─────────────────────────────────────────────────────

export function createWorkerInspectTool(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): ToolDefinition {
    return tool({
        description:
            "Inspect a Paseo worker. Returns current worker details from fresh daemon-backed data.",
        args: {
            workerId: tool.schema.string().describe("ID of the worker to inspect"),
        },
        async execute(args) {
            logger.info("Tool: paseo_worker_inspect invoked", { workerId: args.workerId })

            // Try fresh daemon fetch first
            const fetched = await client.fetchWorker(args.workerId)
            if (fetched) {
                const worker = mapAgentToWorkerSummary(fetched.agent)
                const existing = state.workers.get(args.workerId)
                if (existing) {
                    worker.unreadEventCount = existing.unreadEventCount
                }
                upsertWorker(state, worker)

                return {
                    title: `Worker Inspect: ${args.workerId}`,
                    output: JSON.stringify(
                        {
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
                            createdAt: worker.createdAt,
                            updatedAt: worker.updatedAt,
                            project: fetched.project,
                        },
                        null,
                        2,
                    ),
                }
            }

            // Fallback to local state
            const local = state.workers.get(args.workerId)
            if (!local) {
                throw new Error(`Worker "${args.workerId}" not found`)
            }

            return {
                title: `Worker Inspect: ${args.workerId}`,
                output: JSON.stringify(
                    {
                        id: local.id,
                        title: local.title,
                        status: local.status,
                        cwd: local.cwd,
                        provider: local.provider,
                        model: local.model,
                        currentModeId: local.currentModeId,
                        worktreePath: local.worktreePath,
                        branchName: local.branchName,
                        pendingPermissions: local.pendingPermissions,
                        pendingPermissionIds: local.pendingPermissionIds,
                        runtimeInfo: local.runtimeInfo,
                        persistence: local.persistence,
                        source: "local-cache",
                    },
                    null,
                    2,
                ),
            }
        },
    })
}
