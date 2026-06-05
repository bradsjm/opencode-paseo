import { sendNudge } from "../notifier.js"
import { RESERVED_CHAT_ROOM_LABEL } from "../chat/worker-room.js"
import { getOrCreateSession, mapAgentToWorkerSummary, recordCreatedWorker, upsertWorker } from "../state/state.js"
import type { PluginState, WorkerLaunchRecord, WorkerSummary } from "../state/types.js"
import type { CreatedWorker, PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import type { OpencodeClient } from "../profile.js"

const LAUNCH_ID_PREFIX = "launch"
const RESERVED_LAUNCH_ID_LABEL = "opencodePaseo.launchId"
const RESERVED_SESSION_ID_LABEL = "opencodePaseo.sessionId"
const RESERVED_WORKTREE_NAME_LABEL = "opencodePaseo.worktreeName"

export interface EnqueueWorkerLaunchInput {
    sessionId: string
    projectRoot: string
    profile: string
    cwd: string
    provider: string
    model?: string
    modeId: string
    chatRoom?: string
    initialPrompt?: string
    labels?: Record<string, string>
    worktreeName?: string
}

export interface WorkerLaunchReceipt {
    launchId: string
    status: "queued"
    position: number
    profile: string
    cwd: string
    worktreeName: string | null
    chatRoom: string | null
}

export interface WorkerLaunchStatusSnapshot {
    launchId: string
    status: WorkerLaunchRecord["status"]
    profile: string
    cwd: string
    worktreeName: string | null
    chatRoom: string | null
    enqueuedAt: string
    startedAt: string | null
    finishedAt: string | null
    position?: number
    workerId?: string
    error?: string
}

export interface WorkerLaunchQueueController {
    enqueueWorkerLaunch(input: EnqueueWorkerLaunchInput): WorkerLaunchReceipt
    drainWorkerLaunchQueue(): Promise<void>
    getWorkerLaunchStatus(launchId: string): WorkerLaunchStatusSnapshot
}

function generateLaunchId(): string {
    return `${LAUNCH_ID_PREFIX}-${crypto.randomUUID()}`
}

function toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function getQueuedPosition(state: PluginState, launchId: string): number {
    const index = state.workerLaunchQueue.indexOf(launchId)
    return index >= 0 ? index + 1 : 0
}

function buildLaunchLabels(input: EnqueueWorkerLaunchInput, launchId: string): Record<string, string> {
    const labels = { ...(input.labels ?? {}) }
    labels[RESERVED_LAUNCH_ID_LABEL] = launchId
    labels[RESERVED_SESSION_ID_LABEL] = input.sessionId
    if (input.worktreeName) {
        labels[RESERVED_WORKTREE_NAME_LABEL] = input.worktreeName
    }
    if (input.chatRoom) {
        labels[RESERVED_CHAT_ROOM_LABEL] = input.chatRoom
    }
    return labels
}

function buildFallbackWorker(record: WorkerLaunchRecord, created: CreatedWorker): WorkerSummary {
    return mapAgentToWorkerSummary({
        id: created.id,
        provider: created.provider,
        cwd: created.cwd,
        model: created.model,
        status: created.status,
        title: created.title,
        labels: record.labels,
        runtimeInfo: { currentModeId: record.modeId },
    })
}

function buildCreatedNudgeMessage(launchId: string, workerId: string): string {
    return `[paseo:worker-launch.created] Launch ${launchId} created worker ${workerId}`
}

function buildFailedNudgeMessage(launchId: string, error: string): string {
    return `[paseo:worker-launch.failed] Launch ${launchId} failed: ${error}`
}

export function createWorkerLaunchQueueController(
    state: PluginState,
    client: PaseoTransport,
    opencodeClient: OpencodeClient,
    logger: Logger,
    onWorkerObserved?: (worker: WorkerSummary) => void,
): WorkerLaunchQueueController {
    let draining = false

    async function drainWorkerLaunchQueue(): Promise<void> {
        if (draining) {
            return
        }

        draining = true

        try {
            while (state.workerLaunchQueue.length > 0) {
                if (state.activeWorkerLaunchId) {
                    return
                }

                const launchId = state.workerLaunchQueue.shift()
                if (!launchId) {
                    continue
                }

                const record = state.workerLaunches.get(launchId)
                if (!record) {
                    continue
                }

                state.activeWorkerLaunchId = launchId
                record.status = "starting"
                record.startedAt = new Date().toISOString()

                try {
                    const created = await client.createWorker({
                        cwd: record.cwd,
                        profile: record.profile,
                        provider: record.provider,
                        ...(record.model !== undefined ? { model: record.model } : {}),
                        modeId: record.modeId,
                        ...(record.initialPrompt !== null ? { initialPrompt: record.initialPrompt } : {}),
                        labels: record.labels,
                        ...(record.worktreeName !== null ? { worktreeName: record.worktreeName } : {}),
                    })

                    record.status = "created"
                    record.workerId = created.id
                    record.finishedAt = new Date().toISOString()

                    try {
                        const worker = buildFallbackWorker(record, created)
                        getOrCreateSession(state, record.sessionId, record.projectRoot)
                        recordCreatedWorker(state, record.sessionId, worker)
                        onWorkerObserved?.(worker)
                    } catch (err: unknown) {
                        logger.warn("Worker launch bookkeeping failed", {
                            launchId,
                            workerId: created.id,
                            error: toErrorMessage(err),
                        })
                    }

                    try {
                        const enriched = await client.fetchWorker(created.id)
                        if (enriched?.agent) {
                            const mapped = mapAgentToWorkerSummary(enriched.agent)
                            mapped.unreadEventCount = state.workers.get(created.id)?.unreadEventCount ?? 0
                            upsertWorker(state, mapped)
                            onWorkerObserved?.(mapped)
                        }
                    } catch (err: unknown) {
                        logger.warn("Worker launch enrichment failed", {
                            launchId,
                            workerId: created.id,
                            error: toErrorMessage(err),
                        })
                    }

                    sendNudge(
                        opencodeClient,
                        [record.sessionId],
                        buildCreatedNudgeMessage(launchId, created.id),
                        logger,
                    )
                } catch (err: unknown) {
                    const error = toErrorMessage(err)
                    record.status = "failed"
                    record.error = error
                    record.finishedAt = new Date().toISOString()

                    logger.warn("Worker launch failed", { launchId, error })

                    sendNudge(opencodeClient, [record.sessionId], buildFailedNudgeMessage(launchId, error), logger)
                } finally {
                    state.activeWorkerLaunchId = null
                }
            }
        } finally {
            draining = false
            if (!state.activeWorkerLaunchId && state.workerLaunchQueue.length > 0) {
                void drainWorkerLaunchQueue()
            }
        }
    }

    return {
        enqueueWorkerLaunch(input) {
            const launchId = generateLaunchId()
            const position = state.workerLaunchQueue.length + (state.activeWorkerLaunchId ? 1 : 0) + 1
            const record: WorkerLaunchRecord = {
                launchId,
                status: "queued",
                sessionId: input.sessionId,
                projectRoot: input.projectRoot,
                profile: input.profile,
                cwd: input.cwd,
                worktreeName: input.worktreeName ?? null,
                chatRoom: input.chatRoom ?? null,
                initialPrompt: input.initialPrompt ?? null,
                labels: buildLaunchLabels(input, launchId),
                provider: input.provider,
                model: input.model,
                modeId: input.modeId,
                enqueuedAt: new Date().toISOString(),
                startedAt: null,
                finishedAt: null,
                workerId: null,
                error: null,
            }

            state.workerLaunches.set(launchId, record)
            state.workerLaunchQueue.push(launchId)

            return {
                launchId,
                status: "queued",
                position,
                profile: record.profile,
                cwd: record.cwd,
                worktreeName: record.worktreeName,
                chatRoom: record.chatRoom,
            }
        },

        async drainWorkerLaunchQueue() {
            await drainWorkerLaunchQueue()
        },

        getWorkerLaunchStatus(launchId) {
            const record = state.workerLaunches.get(launchId)
            if (!record) {
                throw new Error(`Worker launch "${launchId}" not found`)
            }

            return {
                launchId: record.launchId,
                status: record.status,
                profile: record.profile,
                cwd: record.cwd,
                worktreeName: record.worktreeName,
                chatRoom: record.chatRoom,
                enqueuedAt: record.enqueuedAt,
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                ...(record.status === "queued" ? { position: getQueuedPosition(state, launchId) } : {}),
                ...(record.workerId ? { workerId: record.workerId } : {}),
                ...(record.error ? { error: record.error } : {}),
            }
        },
    }
}
