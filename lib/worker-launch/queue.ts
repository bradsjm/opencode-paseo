import { sendNudge } from "../notifier.js"
import { RESERVED_CHAT_ROOM_LABEL } from "../chat/worker-room.js"
import { mergePaseoParentAgentLabel } from "../parent-agent-label.js"
import {
  getOrCreateSession,
  getUnreadEventCountForResource,
  mapAgentToWorkerSummary,
  recordBackgroundWorker,
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
import type { PluginConfig } from "../config.js"

const LAUNCH_ID_PREFIX = "launch"
const RESERVED_LAUNCH_ID_LABEL = "opencodePaseo.launchId"
const RESERVED_SESSION_ID_LABEL = "opencodePaseo.sessionId"
const RESERVED_WORKTREE_NAME_LABEL = "opencodePaseo.worktreeName"
const ROLLBACK_NOT_NEEDED_MESSAGE = "Worker launch failed. No new worktree was detected, so no cleanup is needed."
const ROLLBACK_NEEDS_CLEANUP_MESSAGE =
  "Worker launch failed and a possible launch-created worktree could not be safely cleaned up automatically. Inspect candidateWorktrees and use paseo_worktree_archive if appropriate."
const ROLLBACK_ROLLED_BACK_MESSAGE =
  "Worker launch failed after creating a worktree. The plugin archived that worktree automatically."

/**
 * Input required to queue a new worker launch.
 */
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

/**
 * Receipt returned when a worker launch is queued.
 */
export interface WorkerLaunchReceipt {
  launchId: string
  status: "queued"
  position: number
  profile: string
  cwd: string
  worktreeName: string | null
  chatRoom: string | null
}

/**
 * Snapshot of a worker launch's current queue or execution state.
 */
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

/**
 * Controller for queuing, draining, observing, and inspecting worker launches.
 */
export interface WorkerLaunchQueueController {
  enqueueWorkerLaunch(input: EnqueueWorkerLaunchInput): WorkerLaunchReceipt
  drainWorkerLaunchQueue(): Promise<void>
  getWorkerLaunchStatus(launchId: string): WorkerLaunchStatusSnapshot
  observeWorker(worker: WorkerSummary, observedLaunchId?: string): void
}

type WorkerObservedCallback = (worker: WorkerSummary) => void

/**
 * Extracts the reserved launch ID from a label object.
 *
 * @param labels - Candidate label object to inspect.
 * @returns The launch ID when present and non-empty; otherwise `undefined`.
 */
export function getWorkerLaunchIdFromLabels(labels: unknown): string | undefined {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return undefined
  }

  const launchId = (labels as Record<string, unknown>)[RESERVED_LAUNCH_ID_LABEL]
  return typeof launchId === "string" && launchId.trim() ? launchId : undefined
}

/**
 * Extracts the reserved session ID from a label object.
 *
 * @param labels - Candidate label object to inspect.
 * @returns The session ID when present and non-empty; otherwise `undefined`.
 */
export function getWorkerSessionIdFromLabels(labels: unknown): string | undefined {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return undefined
  }

  const sessionId = (labels as Record<string, unknown>)[RESERVED_SESSION_ID_LABEL]
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined
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

/**
 * Creates the queued worker-launch controller.
 *
 * @param state - Shared plugin state used for launch bookkeeping.
 * @param client - Transport used to create workers and manage rollback worktrees.
 * @param config - Plugin configuration for the overload that accepts it explicitly.
 * @param opencodeClient - OpenCode client used to send nudges.
 * @param logger - Logger used for warnings and diagnostics.
 * @param onWorkerObserved - Optional callback invoked after a worker is observed.
 * @returns A controller that can enqueue, drain, and inspect worker launches.
 */
export function createWorkerLaunchQueueController(
  state: PluginState,
  client: PaseoTransport,
  config: PluginConfig,
  opencodeClient: OpencodeClient,
  logger: Logger,
  onWorkerObserved?: WorkerObservedCallback,
): WorkerLaunchQueueController
/**
 * Creates the queued worker-launch controller.
 *
 * @param state - Shared plugin state used for launch bookkeeping.
 * @param client - Transport used to create workers and manage rollback worktrees.
 * @param opencodeClient - OpenCode client used to send nudges.
 * @param logger - Logger used for warnings and diagnostics.
 * @param onWorkerObserved - Optional callback invoked after a worker is observed.
 * @returns A controller that can enqueue, drain, and inspect worker launches.
 */
export function createWorkerLaunchQueueController(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  onWorkerObserved?: WorkerObservedCallback,
): WorkerLaunchQueueController
/**
 * Creates the queued worker-launch controller.
 *
 * @param state - Shared plugin state used for launch bookkeeping.
 * @param client - Transport used to create workers and manage rollback worktrees.
 * @param configOrOpencodeClient - Plugin config when provided, otherwise the OpenCode client.
 * @param opencodeClientOrLogger - OpenCode client when config is provided, otherwise the logger.
 * @param loggerOrOnWorkerObserved - Logger when config is provided, otherwise the optional observation callback.
 * @param maybeOnWorkerObserved - Optional callback invoked after a worker is observed when config is provided.
 * @returns A controller that can enqueue, drain, and inspect worker launches.
 */
export function createWorkerLaunchQueueController(
  state: PluginState,
  client: PaseoTransport,
  configOrOpencodeClient: PluginConfig | OpencodeClient,
  opencodeClientOrLogger: OpencodeClient | Logger,
  loggerOrOnWorkerObserved?: Logger | WorkerObservedCallback,
  maybeOnWorkerObserved?: WorkerObservedCallback,
): WorkerLaunchQueueController {
  const hasConfig = "nudgeEnabled" in configOrOpencodeClient
  const config = hasConfig ? configOrOpencodeClient : { nudgeEnabled: true }
  const opencodeClient = hasConfig ? (opencodeClientOrLogger as OpencodeClient) : configOrOpencodeClient
  const logger = hasConfig ? (loggerOrOnWorkerObserved as Logger) : (opencodeClientOrLogger as Logger)
  const onWorkerObserved = hasConfig
    ? maybeOnWorkerObserved
    : (loggerOrOnWorkerObserved as WorkerObservedCallback | undefined)
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
    recordBackgroundWorker(state, record.sessionId, worker.id)
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

        try {
          await processWorkerLaunch(launchId, record)
        } catch (err: unknown) {
          finalizeWorkerLaunchFailure(launchId, record, err)
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

  async function processWorkerLaunch(launchId: string, record: WorkerLaunchRecord): Promise<void> {
    const rollbackBaseline = await captureRollbackBaseline(launchId, record)
    try {
      const created = await client.createWorker(buildWorkerCreatePayload(record))
      markWorkerLaunchCreated(record, created)
      recordLaunchFallbackWorker(launchId, record, created)
      await enrichCreatedWorker(launchId, created.id)
      sendLaunchNudge(record.sessionId, buildCreatedNudgeMessage(launchId, created.id))
    } catch (err: unknown) {
      await applyWorkerLaunchFailureRollback(launchId, record, err, rollbackBaseline)
      throw err
    }
  }

  async function captureRollbackBaseline(launchId: string, record: WorkerLaunchRecord) {
    if (!record.worktreeName) return { snapshot: null, failed: false }
    try {
      return { snapshot: await listRollbackSnapshot(client, record.cwd), failed: false }
    } catch (err: unknown) {
      logger.warn("Worker launch rollback baseline failed", { launchId, cwd: record.cwd, error: toErrorMessage(err) })
      return { snapshot: null, failed: true }
    }
  }

  function buildWorkerCreatePayload(record: WorkerLaunchRecord) {
    return {
      cwd: record.cwd,
      profile: record.profile,
      provider: record.provider,
      ...(record.model !== undefined ? { model: record.model } : {}),
      modeId: record.modeId,
      ...(record.initialPrompt !== null ? { initialPrompt: record.initialPrompt } : {}),
      labels: record.labels,
      ...(record.worktreeName !== null ? { worktreeName: record.worktreeName } : {}),
    }
  }

  function markWorkerLaunchCreated(record: WorkerLaunchRecord, created: CreatedWorker): void {
    record.status = "created"
    record.workerId = created.id
    record.finishedAt = new Date().toISOString()
  }

  function recordLaunchFallbackWorker(launchId: string, record: WorkerLaunchRecord, created: CreatedWorker): void {
    try {
      const worker = buildFallbackWorker(record, created)
      getOrCreateSession(state, record.sessionId, record.projectRoot)
      recordCreatedWorker(state, record.sessionId, worker)
      recordBackgroundWorker(state, record.sessionId, worker.id)
      onWorkerObserved?.(worker)
    } catch (err: unknown) {
      logger.warn("Worker launch bookkeeping failed", { launchId, workerId: created.id, error: toErrorMessage(err) })
    }
  }

  async function enrichCreatedWorker(launchId: string, workerId: string): Promise<void> {
    try {
      const enriched = await client.fetchWorker(workerId)
      if (!enriched?.agent) return
      const mapped = mapAgentToWorkerSummary(enriched.agent)
      mapped.unreadEventCount = getUnreadEventCountForResource(state, workerId)
      upsertWorker(state, mapped)
      onWorkerObserved?.(mapped)
    } catch (err: unknown) {
      logger.warn("Worker launch enrichment failed", { launchId, workerId, error: toErrorMessage(err) })
    }
  }

  function finalizeWorkerLaunchFailure(launchId: string, record: WorkerLaunchRecord, err: unknown): void {
    const error = toErrorMessage(err)
    record.error = error
    record.finishedAt = new Date().toISOString()
    logger.warn("Worker launch failed", { launchId, error, rollbackOutcome: record.rollback?.outcome ?? null })
    sendLaunchNudge(record.sessionId, buildFailedNudgeMessageForOutcome(launchId, record.status, error))
  }

  function sendLaunchNudge(sessionId: string, message: string): void {
    if (!config.nudgeEnabled) return
    sendNudge(opencodeClient, [sessionId], message, logger)
  }

  async function applyWorkerLaunchFailureRollback(
    launchId: string,
    record: WorkerLaunchRecord,
    err: unknown,
    baseline: { snapshot: WorkerLaunchRollbackSnapshotEntry[] | null; failed: boolean },
  ): Promise<void> {
    record.error = toErrorMessage(err)
    record.finishedAt = new Date().toISOString()
    if (!record.worktreeName) return markLaunchFailedWithoutRollback(record)
    if (baseline.failed || !baseline.snapshot) return markLaunchNeedsCleanup(record, baseline.snapshot, false)
    await assessWorkerLaunchRollback(launchId, record, baseline.snapshot)
  }

  function markLaunchFailedWithoutRollback(record: WorkerLaunchRecord): void {
    record.status = "failed"
    record.rollback = null
  }

  function markLaunchNeedsCleanup(
    record: WorkerLaunchRecord,
    baselineSnapshot: WorkerLaunchRollbackSnapshotEntry[] | null,
    attempted: boolean,
    candidateWorktrees?: WorkerLaunchRollbackCandidate[],
  ): void {
    record.status = "failed_needs_cleanup"
    record.rollback = buildNeedsCleanupRollbackMetadata(ROLLBACK_NEEDS_CLEANUP_MESSAGE, {
      baselineSnapshot,
      attempted,
      candidateWorktrees,
    })
  }

  async function assessWorkerLaunchRollback(
    launchId: string,
    record: WorkerLaunchRecord,
    rollbackBaseline: WorkerLaunchRollbackSnapshotEntry[],
  ): Promise<void> {
    try {
      const newWorktrees = diffNewWorktrees(rollbackBaseline, await listRollbackSnapshot(client, record.cwd))
      await applyRollbackAssessment(record, rollbackBaseline, newWorktrees)
    } catch (listErr: unknown) {
      markLaunchNeedsCleanup(record, rollbackBaseline, false)
      logger.warn("Worker launch rollback assessment failed", {
        launchId,
        cwd: record.cwd,
        error: toErrorMessage(listErr),
      })
    }
  }

  async function applyRollbackAssessment(
    record: WorkerLaunchRecord,
    rollbackBaseline: WorkerLaunchRollbackSnapshotEntry[],
    newWorktrees: WorkerLaunchRollbackSnapshotEntry[],
  ): Promise<void> {
    if (newWorktrees.length === 0) return markRollbackNotNeeded(record)
    if (newWorktrees.length === 1 && newWorktrees[0]?.branchName === record.worktreeName)
      return archiveRollbackCandidate(record, rollbackBaseline, newWorktrees[0])
    markLaunchNeedsCleanup(
      record,
      rollbackBaseline,
      false,
      newWorktrees.map((candidate) => toRollbackCandidate(candidate)),
    )
  }

  function markRollbackNotNeeded(record: WorkerLaunchRecord): void {
    record.status = "failed"
    record.rollback = buildNotNeededRollbackMetadata()
  }

  async function archiveRollbackCandidate(
    record: WorkerLaunchRecord,
    rollbackBaseline: WorkerLaunchRollbackSnapshotEntry[],
    candidate: WorkerLaunchRollbackSnapshotEntry,
  ): Promise<void> {
    try {
      const archiveResult = await client.archiveWorktree({ worktreePath: candidate.worktreePath, cwd: record.cwd })
      if (!archiveResult.success)
        throw new Error(archiveResult.error?.message ?? "archiveWorktree returned success=false")
      record.status = "failed_rolled_back"
      record.rollback = buildRolledBackRollbackMetadata(rollbackBaseline, [toRollbackCandidate(candidate)])
    } catch (archiveErr: unknown) {
      markLaunchNeedsCleanup(record, rollbackBaseline, true, [
        toRollbackCandidate(candidate, toErrorMessage(archiveErr)),
      ])
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
