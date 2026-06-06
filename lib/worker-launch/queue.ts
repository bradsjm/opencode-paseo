import { sendNudge } from "../notifier.js"
import { RESERVED_CHAT_ROOM_LABEL } from "../chat/worker-room.js"
import { mergePaseoParentAgentLabel } from "../parent-agent-label.js"
import {
  getOrCreateSession,
  getUnreadEventCountForResource,
  mapAgentToWorkerSummary,
  recordCreatedWorker,
  upsertWorker,
} from "../state/state.js"
import type {
  PluginState,
  WorkerLaunchRecord,
  WorkerLaunchRollbackCandidate,
  WorkerLaunchRollbackMetadata,
  WorkerLaunchRollbackSnapshotEntry,
  WorkerLaunchStatusRollbackMetadata,
  WorkerSummary,
} from "../state/types.js"
import type { CreatedWorker, PaseoTransport, WorktreeListEntry } from "../transport/types.js"
import type { Logger } from "../logger.js"
import type { OpencodeClient } from "../profile.js"

const LAUNCH_ID_PREFIX = "launch"
const RESERVED_LAUNCH_ID_LABEL = "opencodePaseo.launchId"
const RESERVED_SESSION_ID_LABEL = "opencodePaseo.sessionId"
const RESERVED_WORKTREE_NAME_LABEL = "opencodePaseo.worktreeName"
const ROLLBACK_NOT_NEEDED_MESSAGE = "Worker launch failed. No new worktree was detected, so no cleanup is needed."
const ROLLBACK_NEEDS_CLEANUP_MESSAGE =
  "Worker launch failed and a possible launch-created worktree could not be safely cleaned up automatically. Inspect candidateWorktrees and use paseo_worktree_archive if appropriate."
const ROLLBACK_ROLLED_BACK_MESSAGE =
  "Worker launch failed after creating a worktree. The plugin archived that worktree automatically."

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
  rollback?: WorkerLaunchStatusRollbackMetadata
}

export interface WorkerLaunchQueueController {
  enqueueWorkerLaunch(input: EnqueueWorkerLaunchInput): WorkerLaunchReceipt
  drainWorkerLaunchQueue(): Promise<void>
  getWorkerLaunchStatus(launchId: string): WorkerLaunchStatusSnapshot
  observeWorker(worker: WorkerSummary, observedLaunchId?: string): void
}

export function getWorkerLaunchIdFromLabels(labels: unknown): string | undefined {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return undefined
  }

  const launchId = (labels as Record<string, unknown>)[RESERVED_LAUNCH_ID_LABEL]
  return typeof launchId === "string" && launchId.trim() ? launchId : undefined
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
  return mergePaseoParentAgentLabel(labels) ?? labels
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

function normalizeRollbackSnapshot(entries: WorktreeListEntry[]): WorkerLaunchRollbackSnapshotEntry[] {
  return entries.map((entry) => ({
    worktreePath: entry.worktreePath,
    branchName: entry.branchName ?? null,
  }))
}

function buildNotNeededRollbackMetadata(): WorkerLaunchRollbackMetadata {
  return {
    baselineSnapshot: null,
    attempted: false,
    outcome: "not_needed",
    message: ROLLBACK_NOT_NEEDED_MESSAGE,
  }
}

function buildNeedsCleanupRollbackMetadata(
  message: string,
  options: {
    baselineSnapshot?: WorkerLaunchRollbackSnapshotEntry[] | null
    attempted?: boolean
    candidateWorktrees?: WorkerLaunchRollbackCandidate[]
  } = {},
): WorkerLaunchRollbackMetadata {
  return {
    baselineSnapshot: options.baselineSnapshot ?? null,
    attempted: options.attempted ?? false,
    outcome: "needs_cleanup",
    message,
    suggestedTool: "paseo_worktree_archive",
    ...(options.candidateWorktrees?.length ? { candidateWorktrees: options.candidateWorktrees } : {}),
  }
}

function buildRolledBackRollbackMetadata(
  baselineSnapshot: WorkerLaunchRollbackSnapshotEntry[] | null,
  candidateWorktrees: WorkerLaunchRollbackCandidate[],
): WorkerLaunchRollbackMetadata {
  return {
    baselineSnapshot,
    attempted: true,
    outcome: "rolled_back",
    message: ROLLBACK_ROLLED_BACK_MESSAGE,
    candidateWorktrees,
  }
}

function buildFailedNudgeMessageForOutcome(
  launchId: string,
  status: WorkerLaunchRecord["status"],
  error: string,
): string {
  if (status === "failed_rolled_back") {
    return `[paseo:worker-launch.failed_rolled_back] Launch ${launchId} failed: ${error}. Launch-created worktree was archived automatically.`
  }
  if (status === "failed_needs_cleanup") {
    return `[paseo:worker-launch.failed_needs_cleanup] Launch ${launchId} failed: ${error}. Possible orphaned worktree detected; check launch status and consider paseo_worktree_archive.`
  }
  return buildFailedNudgeMessage(launchId, `${error}. No cleanup needed.`)
}

async function listRollbackSnapshot(client: PaseoTransport, cwd: string): Promise<WorkerLaunchRollbackSnapshotEntry[]> {
  const result = await client.listWorktrees({ cwd })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return normalizeRollbackSnapshot(result.worktrees)
}

function diffNewWorktrees(
  baseline: WorkerLaunchRollbackSnapshotEntry[],
  current: WorkerLaunchRollbackSnapshotEntry[],
): WorkerLaunchRollbackSnapshotEntry[] {
  const baselinePaths = new Set(baseline.map((entry) => entry.worktreePath))
  return current.filter((entry) => !baselinePaths.has(entry.worktreePath))
}

function toRollbackCandidate(
  entry: WorkerLaunchRollbackSnapshotEntry,
  archiveError?: string,
): WorkerLaunchRollbackCandidate {
  return {
    worktreePath: entry.worktreePath,
    branchName: entry.branchName,
    ...(archiveError ? { archiveError } : {}),
  }
}

export function createWorkerLaunchQueueController(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  onWorkerObserved?: (worker: WorkerSummary) => void,
): WorkerLaunchQueueController {
  let draining = false

  function observeWorker(worker: WorkerSummary, observedLaunchId?: string): void {
    if (!observedLaunchId) {
      return
    }

    const record = state.workerLaunches.get(observedLaunchId)
    if (!record || (record.status !== "queued" && record.status !== "starting")) {
      return
    }

    record.status = "created"
    record.workerId = worker.id
    record.startedAt ??= new Date().toISOString()
    record.finishedAt ??= new Date().toISOString()
  }

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

        let rollbackBaseline: WorkerLaunchRollbackSnapshotEntry[] | null = null
        let rollbackBaselineFailed = false

        if (record.worktreeName) {
          try {
            rollbackBaseline = await listRollbackSnapshot(client, record.cwd)
          } catch (err: unknown) {
            rollbackBaselineFailed = true
            logger.warn("Worker launch rollback baseline failed", {
              launchId,
              cwd: record.cwd,
              error: toErrorMessage(err),
            })
          }
        }

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
              mapped.unreadEventCount = getUnreadEventCountForResource(state, created.id)
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

          sendNudge(opencodeClient, [record.sessionId], buildCreatedNudgeMessage(launchId, created.id), logger)
        } catch (err: unknown) {
          const error = toErrorMessage(err)
          record.error = error
          record.finishedAt = new Date().toISOString()

          if (!record.worktreeName) {
            record.status = "failed"
            record.rollback = null
          } else if (rollbackBaselineFailed || !rollbackBaseline) {
            record.status = "failed_needs_cleanup"
            record.rollback = buildNeedsCleanupRollbackMetadata(ROLLBACK_NEEDS_CLEANUP_MESSAGE, {
              baselineSnapshot: rollbackBaseline,
              attempted: false,
            })
          } else {
            try {
              const postFailureSnapshot = await listRollbackSnapshot(client, record.cwd)
              const newWorktrees = diffNewWorktrees(rollbackBaseline, postFailureSnapshot)

              if (newWorktrees.length === 0) {
                record.status = "failed"
                record.rollback = buildNotNeededRollbackMetadata()
              } else if (newWorktrees.length === 1 && newWorktrees[0]?.branchName === record.worktreeName) {
                const candidate = newWorktrees[0]
                try {
                  const archiveResult = await client.archiveWorktree({
                    worktreePath: candidate.worktreePath,
                    cwd: record.cwd,
                  })
                  if (!archiveResult.success) {
                    throw new Error(archiveResult.error?.message ?? "archiveWorktree returned success=false")
                  }
                  record.status = "failed_rolled_back"
                  record.rollback = buildRolledBackRollbackMetadata(rollbackBaseline, [toRollbackCandidate(candidate)])
                } catch (archiveErr: unknown) {
                  record.status = "failed_needs_cleanup"
                  record.rollback = buildNeedsCleanupRollbackMetadata(ROLLBACK_NEEDS_CLEANUP_MESSAGE, {
                    baselineSnapshot: rollbackBaseline,
                    attempted: true,
                    candidateWorktrees: [toRollbackCandidate(candidate, toErrorMessage(archiveErr))],
                  })
                }
              } else {
                record.status = "failed_needs_cleanup"
                record.rollback = buildNeedsCleanupRollbackMetadata(ROLLBACK_NEEDS_CLEANUP_MESSAGE, {
                  baselineSnapshot: rollbackBaseline,
                  attempted: false,
                  candidateWorktrees: newWorktrees.map((candidate) => toRollbackCandidate(candidate)),
                })
              }
            } catch (listErr: unknown) {
              record.status = "failed_needs_cleanup"
              record.rollback = buildNeedsCleanupRollbackMetadata(ROLLBACK_NEEDS_CLEANUP_MESSAGE, {
                baselineSnapshot: rollbackBaseline,
                attempted: false,
              })
              logger.warn("Worker launch rollback assessment failed", {
                launchId,
                cwd: record.cwd,
                error: toErrorMessage(listErr),
              })
            }
          }

          logger.warn("Worker launch failed", {
            launchId,
            error,
            rollbackOutcome: record.rollback?.outcome ?? null,
          })

          sendNudge(
            opencodeClient,
            [record.sessionId],
            buildFailedNudgeMessageForOutcome(launchId, record.status, error),
            logger,
          )
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
        rollback: null,
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

    observeWorker,

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
        ...(record.rollback
          ? {
              rollback: {
                attempted: record.rollback.attempted,
                outcome: record.rollback.outcome,
                message: record.rollback.message,
                ...(record.rollback.suggestedTool ? { suggestedTool: record.rollback.suggestedTool } : {}),
                ...(record.rollback.candidateWorktrees
                  ? { candidateWorktrees: record.rollback.candidateWorktrees }
                  : {}),
              },
            }
          : {}),
      }
    },
  }
}
