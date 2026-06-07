import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState, WorkerStatus, WorkerSummary } from "../state/types.js"
import type { PluginConfig } from "../config.js"
import { appendChatRoomCoordinationPrompt, normalizeChatRoom } from "../chat/worker-room.js"
import type { WorkerLaunchQueueController } from "../worker-launch/queue.js"
import type {
  DaemonEvent,
  MultiWorkerWaitResult,
  PaseoTransport,
  WorkerLastMessage,
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
  getUnreadEventCountForResource,
  upsertWorker,
  mapAgentToWorkerSummary,
  removeWorkerFromState,
  getBlockingAction,
  markResourceEventsRead,
  recordBackgroundWorker,
  unrecordBackgroundWorker,
} from "../state/state.js"
import { getWorkerLaunchIdFromLabels } from "../worker-launch/queue.js"
import { collapseNull, compactDefined, nullableOptional, optionalNonBlankString, optionalNumber } from "./args.js"

type WorkerRefreshObserver = (worker: WorkerSummary, observedLaunchId?: string) => void

async function resolveWorkerProfileFields(
  opencodeClient: OpencodeClient,
  cwd: string,
  profileInput: string | undefined,
) {
  const profileName = normalizeProfileName(profileInput)
  const profiles = await listProfiles(opencodeClient, cwd)
  const profile = resolveProfile(profiles, profileName)
  const workerFields = profileToWorkerFields(profile)
  return { profileName, workerFields }
}

function isWorkerMissingUpstreamError(err: unknown): err is Error {
  return (
    err instanceof Error && /\b(agent|worker)\b.*\bnot found\b|\bnot found\b.*\b(agent|worker)\b/i.test(err.message)
  )
}

// ─── Worker List Tool ────────────────────────────────────────────────────────

/**
 * Create the tool that lists known workers and refreshes local state.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @param onWorkerObserved Optional callback invoked for each observed worker.
 * @returns The OpenCode tool definition.
 */
export function createWorkerListTool(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  onWorkerObserved?: WorkerRefreshObserver,
): ToolDefinition {
  return tool({
    description:
      "List all known Paseo workers. Returns ID, status, cwd, provider/model/mode, and permission data for each worker.",
    args: {},
    async execute() {
      logger.info("Tool: paseo_worker_list invoked")

      const preexistingWorkerIds = new Set(state.workers.keys())
      const agents = await client.fetchAgents(undefined)
      const fetchedWorkerIds = new Set<string>()

      for (const a of agents) {
        fetchedWorkerIds.add(a.id)
        const worker = mapAgentToWorkerSummary(a)
        worker.unreadEventCount = getUnreadEventCountForResource(state, worker.id)
        upsertWorker(state, worker)
        onWorkerObserved?.(worker, getWorkerLaunchIdFromLabels(a.labels))
      }

      for (const workerId of preexistingWorkerIds) {
        if (!fetchedWorkerIds.has(workerId)) {
          removeWorkerFromState(state, workerId)
        }
      }

      const workers = Array.from(state.workers.values()).map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        cwd: w.cwd,
        provider: w.provider,
        model: w.model,
        currentModeId: w.currentModeId,
        chatRoom: w.chatRoom,
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

/**
 * Create the tool that queues a new worker launch.
 *
 * @param opencodeClient OpenCode client used to resolve profile configuration.
 * @param workerLaunchQueue Worker launch queue controller.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
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
      "This tool returns a launch receipt immediately. Worker launches are queued and serialized per plugin instance: one launch starts at a time, in FIFO order, not in parallel. " +
      "Do not treat launch as complete until paseo_worker_launch_status returns status created and a workerId. " +
      "Use paseo_worker_launch_status to check launch progress and worker ID once created. When the plugin runs inside " +
      "a Paseo agent environment, it also sets the reserved paseo.parent-agent-id label automatically.",
    args: {
      cwd: nullableOptional(tool.schema.string()).describe(
        "Working directory for the worker (defaults to session directory)",
      ),
      profile: tool.schema
        .string()
        .nullable()
        .optional()
        .describe(
          `OpenCode profile name to use (default: "${DEFAULT_PROFILE}"). Use paseo_profile_list to see available profiles.`,
        ),
      initialPrompt: nullableOptional(tool.schema.string()).describe(
        "Self-contained initial worker brief: objective, scope, allowed edits, verification, blockers, and required final report fields",
      ),
      labels: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .nullable()
        .optional()
        .describe("Key-value labels to attach to the worker"),
      worktreeName: nullableOptional(tool.schema.string()).describe(
        "Name for a git worktree to create for this worker",
      ),
      chatRoom: nullableOptional(tool.schema.string()).describe(
        "Optional Paseo chat room to coordinate this worker through",
      ),
    },
    async execute(args, context: ToolContext) {
      const cwd = optionalNonBlankString(args.cwd) ?? context.directory
      const chatRoom = normalizeChatRoom(optionalNonBlankString(args.chatRoom))
      const worktreeName = optionalNonBlankString(args.worktreeName)
      const initialPrompt = collapseNull(args.initialPrompt)
      const labels = collapseNull(args.labels)
      const { profileName, workerFields } = await resolveWorkerProfileFields(
        opencodeClient,
        cwd,
        optionalNonBlankString(args.profile),
      )

      logger.info("Tool: paseo_worker_create invoked", {
        cwd,
        profile: profileName,
      })

      const queuedPrompt = chatRoom ? appendChatRoomCoordinationPrompt(initialPrompt, chatRoom) : initialPrompt
      const receipt = workerLaunchQueue.enqueueWorkerLaunch({
        sessionId: context.sessionID,
        projectRoot: context.worktree ?? context.directory,
        profile: profileName,
        provider: workerFields.provider,
        ...compactDefined({ model: workerFields.model }),
        modeId: workerFields.modeId,
        cwd,
        ...compactDefined({
          initialPrompt: queuedPrompt,
          chatRoom,
          labels,
          worktreeName,
        }),
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
            chatRoom: receipt.chatRoom,
            message:
              "Worker launch queued. This receipt only confirms queueing. Launches start one at a time per plugin instance, in FIFO order, not in parallel. " +
              "Use paseo_worker_launch_status with the launchId to monitor progress, and do not treat launch as complete until status is created and workerId is present.",
          },
          null,
          2,
        ),
      }
    },
  })
}

/**
 * Create the tool that reports queued worker launch status.
 *
 * @param workerLaunchQueue Worker launch queue controller.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorkerLaunchStatusTool(
  workerLaunchQueue: WorkerLaunchQueueController,
  logger: Logger,
): ToolDefinition {
  return tool({
    description:
      "Get the status of a queued Paseo worker launch. Returns queued/starting/created/failure state, workerId when available, and rollback details for failed launches.",
    args: {
      launchId: tool.schema.string().describe("ID of the worker launch to inspect"),
    },
    execute(args) {
      return Promise.resolve().then(() => {
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
              chatRoom: status.chatRoom,
              enqueuedAt: status.enqueuedAt,
              startedAt: status.startedAt,
              finishedAt: status.finishedAt,
              ...(status.position !== undefined ? { position: status.position } : {}),
              ...(status.workerId ? { workerId: status.workerId } : {}),
              ...(status.error ? { error: status.error } : {}),
              ...(status.rollback ? { rollback: status.rollback } : {}),
            },
            null,
            2,
          ),
        }
      })
    },
  })
}

// ─── Worker Send Tool ────────────────────────────────────────────────────────

/**
 * Create the tool that sends a message to an existing worker.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorkerSendTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
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
    chatRoom?: string
    cwd: string
    worktreePath?: string
    branchName?: string
    createdAt?: string
    updatedAt?: string
    source: "daemon"
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
  lastMessage?: WorkerLastMessage | null
}

interface WorkerInspectTimelineResult {
  activity: WorkerActivitySummary | null
  lastMessage?: WorkerLastMessage | null
}

function isTerminalWorkerStatus(status: string | undefined): boolean {
  return status === "idle" || status === "error" || status === "closed"
}

function deriveActivityState(
  worker: Pick<WorkerSummary, "status" | "pendingPermissionIds" | "requiresAttention">,
  activity: WorkerActivitySummary | null,
  activityFetched: boolean,
): InspectActivityState {
  if (isTerminalWorkerStatus(worker.status)) return "finished"
  if (workerIsBlocked(worker)) return "blocked"
  if (worker.status === "initializing") return "quiet"
  if (worker.status === "running") return runningActivityState(activity, activityFetched)
  return hasProjectedActivity(activity) ? "active" : "unknown"
}

function workerIsBlocked(
  worker: Pick<WorkerSummary, "status" | "pendingPermissionIds" | "requiresAttention">,
): boolean {
  return worker.requiresAttention || worker.pendingPermissionIds.length > 0
}

function hasProjectedActivity(activity: WorkerActivitySummary | null): boolean {
  return Boolean(activity && activity.entries.length > 0)
}

function runningActivityState(activity: WorkerActivitySummary | null, activityFetched: boolean): InspectActivityState {
  if (!activityFetched) return "unknown"
  return hasProjectedActivity(activity) ? "active" : "quiet"
}

function deriveReadyForDependentWork(status: string): ReadyForDependentWork {
  if (status === "idle") return true
  if (status === "running" || status === "initializing" || status === "error") return false
  return "unknown"
}

function deriveProgressSummary(
  worker: Pick<WorkerSummary, "status" | "pendingPermissionIds" | "requiresAttention" | "attentionReason">,
  activityState: InspectActivityState,
  activity: WorkerActivitySummary | null,
  activityFetched: boolean,
): { summary: string; lastMeaningfulUpdate: string | null } {
  const latest = activity?.entries[0]
  if (latest) return latestActivityProgress(latest)
  if (activityState === "blocked") return blockedProgress(worker)
  if (activityState === "finished") return finishedProgress(worker.status)
  if (activityState === "quiet") return progressSummary("Worker is running but has no recent projected activity")
  if (!activityFetched && worker.status === "running")
    return progressSummary("Activity not fetched; worker status is running")
  return progressSummary(worker.status === "idle" ? "Worker is idle" : "No recent projected activity")
}

function latestActivityProgress(entry: WorkerActivitySummary["entries"][number]) {
  return { summary: entry.summary, lastMeaningfulUpdate: entry.timestamp ?? null }
}

function progressSummary(summary: string): { summary: string; lastMeaningfulUpdate: string | null } {
  return { summary, lastMeaningfulUpdate: null }
}

function blockedProgress(worker: Pick<WorkerSummary, "pendingPermissionIds" | "attentionReason">): {
  summary: string
  lastMeaningfulUpdate: string | null
} {
  return progressSummary(
    worker.attentionReason ??
      (worker.pendingPermissionIds.length > 0 ? "Waiting for permission response" : "Worker needs attention"),
  )
}

function finishedProgress(status: string): { summary: string; lastMeaningfulUpdate: string | null } {
  if (status === "error") return progressSummary("Worker failed")
  if (status === "idle") return progressSummary("Worker is idle")
  return progressSummary("Worker reached a terminal state")
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
  if (!config.nudgeEnabled) return null
  if (!isDaemonNudgeEvent(event)) return null
  const workerId = event.payload.workerId
  if (!ownedWorkerIds.has(workerId)) return null
  return { kind: daemonEventToNudgeKind(event), workerId, summary: daemonNudgeSummary(event, workerId) }
}

function isDaemonNudgeEvent(
  event: DaemonEvent,
): event is Extract<DaemonEvent, { type: "worker.stalled" | "agent_permission_request" }> {
  return event.type === "worker.stalled" || event.type === "agent_permission_request"
}

function daemonEventToNudgeKind(event: Extract<DaemonEvent, { type: "worker.stalled" | "agent_permission_request" }>) {
  return event.type === "agent_permission_request" ? "permission.requested" : event.type
}

function daemonNudgeSummary(event: Extract<DaemonEvent, { payload: { workerId: string } }>, workerId: string): string {
  return (
    (typeof event.payload.summary === "string" && event.payload.summary) ||
    (typeof event.payload.message === "string" && event.payload.message) ||
    `${event.type} for ${workerId}`
  )
}

function getExistingUnreadNudge(
  state: PluginState,
  sessionId: string,
  ownedWorkerIds: Set<string>,
  config: PluginConfig,
): WorkerWaitNudgeEvent | null {
  const session = state.sessions.get(sessionId)
  if (!session) {
    return null
  }

  for (const inboxEvent of session.unreadEvents.values()) {
    if (!isUnreadInboxNudge(inboxEvent, ownedWorkerIds, config)) continue
    return { kind: inboxEvent.kind, workerId: inboxEvent.resourceId, summary: inboxEvent.summary }
  }

  return null
}

function isUnreadInboxNudge(
  inboxEvent: { kind: string; resourceId: string },
  ownedWorkerIds: Set<string>,
  config: PluginConfig,
): inboxEvent is { kind: WorkerWaitNudgeEvent["kind"]; resourceId: string; summary: string } {
  return config.nudgeEnabled && ownedWorkerIds.has(inboxEvent.resourceId) && isInboxNudgeKind(inboxEvent.kind)
}

function isInboxNudgeKind(kind: string): kind is WorkerWaitNudgeEvent["kind"] {
  return (
    kind === "worker.stalled" ||
    kind === "agent.status" ||
    kind === "agent.attention" ||
    kind === "chat.mentioned" ||
    kind === "permission.requested"
  )
}

/**
 * Create the tool that waits on one or more workers.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param config Plugin configuration used for wait behavior.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorkerWaitTool(
  state: PluginState,
  client: PaseoTransport,
  config: PluginConfig,
  logger: Logger,
): ToolDefinition {
  return tool({
    description:
      "Wait for one or more Paseo workers to finish their current tasks. Supports waiting for any or all targets, respects a global timeout, and stops early if this session receives a nudge-eligible owned-worker event. Inspect timedOut, interruptedByNudge, pendingWorkerIds, and nudgeEvent before treating the wait as complete.",
    args: {
      workerIds: tool.schema.array(tool.schema.string()).min(1).describe("IDs of one or more workers to wait on"),
      waitFor: tool.schema
        .enum(["any", "all"])
        .nullable()
        .optional()
        .describe(
          'Wait mode: "any" returns after the first target completes; "all" waits for every target. Defaults to "all".',
        ),
      timeout: tool.schema
        .number()
        .int()
        .nullable()
        .optional()
        .describe(`Maximum time to wait in milliseconds (default: ${DEFAULT_WAIT_TIMEOUT_MS})`),
    },
    async execute(args, context: ToolContext) {
      const waitContext = createWorkerWaitContext(state, args, context, config)
      logger.info("Tool: paseo_worker_wait invoked", {
        workerIds: waitContext.workerIds,
        waitFor: waitContext.waitFor,
        sessionId: context.sessionID,
        timeout: waitContext.timeout,
      })
      return runWorkerWait(state, client, config, waitContext)
    },
  })
}

interface WorkerWaitExecutionContext {
  sessionId: string
  waitFor: "any" | "all"
  workerIds: string[]
  timeout: number
  ownedWorkerIds: Set<string>
  pendingWorkerIds: string[]
  completedResults: Map<string, WorkerWaitResult>
  interruptedByNudge: boolean
  nudgeEvent?: WorkerWaitNudgeEvent
}

function createWorkerWaitContext(
  state: PluginState,
  args: { workerIds: string[]; waitFor?: "any" | "all" | null; timeout?: number | null },
  context: ToolContext,
  config: PluginConfig,
): WorkerWaitExecutionContext {
  const workerIds = normalizeWorkerWaitIds(args.workerIds)
  const session = state.sessions.get(context.sessionID)
  const ownedWorkerIds = new Set(session?.backgroundWorkerIds ?? [])
  for (const workerId of workerIds) ownedWorkerIds.delete(workerId)
  const nudgeEvent = getExistingUnreadNudge(state, context.sessionID, ownedWorkerIds, config) ?? undefined
  return {
    sessionId: context.sessionID,
    waitFor: collapseNull(args.waitFor) ?? "all",
    workerIds,
    timeout: optionalNumber(args.timeout) ?? DEFAULT_WAIT_TIMEOUT_MS,
    ownedWorkerIds,
    pendingWorkerIds: [...workerIds],
    completedResults: new Map<string, WorkerWaitResult>(),
    interruptedByNudge: nudgeEvent !== undefined,
    ...(nudgeEvent !== undefined ? { nudgeEvent } : {}),
  }
}

function normalizeWorkerWaitIds(workerIds: string[]): string[] {
  const normalized = Array.from(new Set(workerIds.map((id) => id.trim()).filter(Boolean)))
  if (normalized.length === 0) throw new Error("workerIds must contain at least one non-empty worker ID")
  return normalized
}

async function runWorkerWait(
  state: PluginState,
  client: PaseoTransport,
  config: PluginConfig,
  waitContext: WorkerWaitExecutionContext,
) {
  const restoreBackgroundWorkers = foregroundWaitedWorkers(state, waitContext)
  const unsubscribe = subscribeWorkerWaitNudges(client, config, waitContext)
  try {
    return await pollWorkerWait(state, client, config, waitContext)
  } finally {
    unsubscribe()
    restoreBackgroundWorkers()
  }
}

function subscribeWorkerWaitNudges(
  client: PaseoTransport,
  config: PluginConfig,
  waitContext: WorkerWaitExecutionContext,
) {
  return client.onEvent((event) => {
    if (waitContext.nudgeEvent) return
    const matched = getNudgeEventFromDaemonEvent(event, waitContext.ownedWorkerIds, config)
    if (matched) markWaitInterruptedByNudge(waitContext, matched)
  })
}

function foregroundWaitedWorkers(state: PluginState, waitContext: WorkerWaitExecutionContext): () => void {
  const session = state.sessions.get(waitContext.sessionId)
  if (!session) return () => {}

  const backgroundWorkerIds = waitContext.workerIds.filter((workerId) => session.backgroundWorkerIds.has(workerId))
  for (const workerId of backgroundWorkerIds) {
    unrecordBackgroundWorker(state, waitContext.sessionId, workerId)
  }

  return () => {
    for (const workerId of backgroundWorkerIds) {
      recordBackgroundWorker(state, waitContext.sessionId, workerId)
    }
  }
}

async function pollWorkerWait(
  state: PluginState,
  client: PaseoTransport,
  config: PluginConfig,
  waitContext: WorkerWaitExecutionContext,
) {
  if (waitContext.nudgeEvent) return workerWaitResponse(waitContext, false)
  const deadline = Date.now() + waitContext.timeout
  while (waitContext.pendingWorkerIds.length > 0) {
    const stop = workerWaitEarlyStop(waitContext, deadline)
    if (stop) return stop
    await runWorkerWaitSlice(state, client, waitContext, deadline)
    markUnreadWaitNudge(state, config, waitContext)
    if (waitContext.nudgeEvent) return workerWaitResponse(waitContext, false)
    const complete = workerWaitCompletionResponse(waitContext)
    if (complete) return complete
  }
  return workerWaitResponse(waitContext, false)
}

function workerWaitEarlyStop(waitContext: WorkerWaitExecutionContext, deadline: number) {
  if (waitContext.nudgeEvent) return workerWaitResponse(waitContext, false)
  return deadline - Date.now() <= 0 ? workerWaitResponse(waitContext, true) : null
}

async function runWorkerWaitSlice(
  state: PluginState,
  client: PaseoTransport,
  waitContext: WorkerWaitExecutionContext,
  deadline: number,
): Promise<void> {
  const sliceTimeout = Math.min(WAIT_SLICE_TIMEOUT_MS, deadline - Date.now())
  const settled = await Promise.allSettled(
    waitContext.pendingWorkerIds.map((workerId) => client.waitForWorker(workerId, sliceTimeout)),
  )
  recordWorkerWaitSettledResults(state, waitContext, settled)
}

function recordWorkerWaitSettledResults(
  state: PluginState,
  waitContext: WorkerWaitExecutionContext,
  settled: Array<PromiseSettledResult<WorkerWaitResult>>,
): void {
  for (const settledResult of settled) {
    if (settledResult.status === "rejected") throw settledResult.reason
    syncWorkerFromFinalSnapshot(state, settledResult.value)
    if (settledResult.value.status !== "timeout")
      waitContext.completedResults.set(settledResult.value.workerId, settledResult.value)
  }
  waitContext.pendingWorkerIds = waitContext.pendingWorkerIds.filter(
    (workerId) => !waitContext.completedResults.has(workerId),
  )
}

function workerWaitCompletionResponse(waitContext: WorkerWaitExecutionContext) {
  if (waitContext.waitFor === "any" && waitContext.completedResults.size > 0)
    return workerWaitResponse(waitContext, false)
  if (waitContext.waitFor === "all" && waitContext.pendingWorkerIds.length === 0)
    return workerWaitResponse(waitContext, false)
  return null
}

function markUnreadWaitNudge(state: PluginState, config: PluginConfig, waitContext: WorkerWaitExecutionContext): void {
  const unreadNudge = getExistingUnreadNudge(state, waitContext.sessionId, waitContext.ownedWorkerIds, config)
  if (unreadNudge && !waitContext.nudgeEvent) markWaitInterruptedByNudge(waitContext, unreadNudge)
}

function markWaitInterruptedByNudge(waitContext: WorkerWaitExecutionContext, nudgeEvent: WorkerWaitNudgeEvent): void {
  waitContext.interruptedByNudge = true
  waitContext.nudgeEvent = nudgeEvent
}

function workerWaitResponse(waitContext: WorkerWaitExecutionContext, timedOut: boolean) {
  return { title: "Worker Wait", output: JSON.stringify(buildWorkerWaitPayload(waitContext, timedOut), null, 2) }
}

function buildWorkerWaitPayload(waitContext: WorkerWaitExecutionContext, timedOut: boolean): MultiWorkerWaitResult {
  return {
    waitFor: waitContext.waitFor,
    workerIds: waitContext.workerIds,
    results: waitContext.workerIds
      .filter((workerId) => waitContext.completedResults.has(workerId))
      .map((workerId) => waitContext.completedResults.get(workerId)!),
    pendingWorkerIds: waitContext.pendingWorkerIds,
    interruptedByNudge: waitContext.interruptedByNudge,
    ...(waitContext.nudgeEvent !== undefined ? { nudgeEvent: waitContext.nudgeEvent } : {}),
    timedOut,
  }
}

// ─── Worker Cancel Tool ──────────────────────────────────────────────────────

/**
 * Create the tool that cancels or kills a worker.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorkerCancelTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
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
        .nullable()
        .optional()
        .describe(
          "If true, permanently terminate the worker and remove it from state. " +
            "Destructive and irreversible; capture any needed output or status first. " +
            "Defaults to false.",
        ),
    },
    async execute(args) {
      const isKill = collapseNull(args.forceKill) === true
      logger.info("Tool: paseo_worker_cancel invoked", {
        workerId: args.workerId,
        forceKill: isKill,
      })

      if (isKill) {
        await client.killWorker(args.workerId)

        // Permanent removal: delete from state and unbind sessions
        markResourceEventsRead(state, args.workerId)
        removeWorkerFromState(state, args.workerId)

        return {
          title: "Worker Killed",
          output: JSON.stringify(
            {
              workerId: args.workerId,
              action: "killed",
              warning: "Worker was permanently terminated and removed from plugin state.",
            },
            null,
            2,
          ),
        }
      }

      await client.cancelWorker(args.workerId)

      return {
        title: "Worker Cancel Requested",
        output: JSON.stringify(
          {
            workerId: args.workerId,
            action: "cancel_requested",
            note: "Daemon state may settle asynchronously; use inspect or wait for final status.",
          },
          null,
          2,
        ),
      }
    },
  })
}

// ─── Worker Archive Tool ─────────────────────────────────────────────────────

/**
 * Create the tool that archives a worker.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorkerArchiveTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Archive a Paseo worker. Local active state is removed immediately on success, but daemon-side disappearance " +
      "or historical inspectability may lag briefly afterward.",
    args: {
      workerId: tool.schema.string().describe("ID of the worker to archive"),
    },
    async execute(args) {
      logger.info("Tool: paseo_worker_archive invoked", { workerId: args.workerId })

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
      markResourceEventsRead(state, args.workerId)
      removeWorkerFromState(state, args.workerId)

      return {
        title: "Worker Archived Locally",
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

/**
 * Create the tool that updates worker metadata and runtime settings.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @param onWorkerObserved Optional callback invoked after a refreshed worker is observed.
 * @returns The OpenCode tool definition.
 */
export function createWorkerUpdateTool(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  onWorkerObserved?: WorkerRefreshObserver,
): ToolDefinition {
  return tool({
    description:
      "Update a Paseo worker's metadata and runtime settings. " +
      "Supports name, labels, and settings (modeId, model, thinkingOptionId, features). " +
      "Pass null for model or thinkingOptionId to clear them.",
    args: {
      workerId: tool.schema.string().describe("ID of the worker to update"),
      name: nullableOptional(tool.schema.string()).describe("New display name for the worker"),
      labels: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .nullable()
        .optional()
        .describe("Replacement label map"),
      settings: tool.schema
        .object({
          modeId: nullableOptional(tool.schema.string()).describe("Mode to switch the worker to"),
          model: tool.schema.string().nullable().optional().describe("Model ID to set, or null to clear"),
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
        .nullable()
        .optional()
        .describe("Runtime settings to apply"),
    },
    async execute(args) {
      logger.info("Tool: paseo_worker_update invoked", { workerId: args.workerId })

      const name = collapseNull(args.name)
      const labels = collapseNull(args.labels)
      const settingsInput = collapseNull(args.settings)
      // Preserve nested null clear semantics for model/thinkingOptionId; only collapse ordinary top-level nulls here.
      const settings =
        settingsInput === undefined
          ? undefined
          : compactDefined({
              modeId: collapseNull(settingsInput.modeId),
              model: settingsInput.model,
              thinkingOptionId: settingsInput.thinkingOptionId,
              features: settingsInput.features,
            })

      const result = await client.updateWorker({
        workerId: args.workerId,
        ...compactDefined({ labels, name, settings }),
      })

      // Refresh local state from daemon if update succeeded
      if (result.updated) {
        const fetched = await client.fetchWorker(args.workerId)
        if (fetched) {
          const refreshed = mapAgentToWorkerSummary(fetched.agent)
          refreshed.unreadEventCount = state.workers.get(args.workerId)?.unreadEventCount ?? 0
          upsertWorker(state, refreshed)
          onWorkerObserved?.(refreshed)
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

/**
 * Create the tool that inspects a worker and its recent activity.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param config Plugin configuration used for output shaping.
 * @param logger Logger used for invocation tracing.
 * @param onWorkerObserved Optional callback invoked after a refreshed worker is observed.
 * @returns The OpenCode tool definition.
 */
export function createWorkerInspectTool(
  state: PluginState,
  client: PaseoTransport,
  config: PluginConfig,
  logger: Logger,
  onWorkerObserved?: WorkerRefreshObserver,
): ToolDefinition {
  return tool({
    description:
      "Inspect a Paseo worker. Returns a compact daemon-backed summary for routing, attention, and progress decisions. " +
      "Check progress.readyForDependentWork before starting dependent work. Optionally includes a projected recent activity summary when includeActivity is true and the latest assistant/final reply body when includeLastMessage is true.",
    args: {
      workerId: tool.schema.string().describe("ID of the worker to inspect"),
      includeActivity: tool.schema
        .boolean()
        .nullable()
        .optional()
        .describe("If true, include the worker's recent projected activity summary"),
      includeLastMessage: tool.schema
        .boolean()
        .nullable()
        .optional()
        .describe("If true, include the worker's latest assistant/final reply body when available"),
      activityLimit: nullableOptional(tool.schema.number()).describe(
        "Maximum number of projected activity entries to return",
      ),
    },
    async execute(args) {
      const includeActivity = collapseNull(args.includeActivity)
      const includeLastMessage = collapseNull(args.includeLastMessage)
      const activityLimit = optionalNumber(args.activityLimit)
      logger.info("Tool: paseo_worker_inspect invoked", {
        workerId: args.workerId,
        includeActivity,
        includeLastMessage,
      })

      const { fetched, worker } = await fetchAndStoreWorkerSnapshot(state, client, args.workerId, onWorkerObserved)
      const activityFetched = Boolean(includeActivity)
      const timeline = await fetchInspectTimeline(
        client,
        args.workerId,
        includeActivity === true,
        includeLastMessage === true,
        activityLimit,
        config.output.maxSummaryLength,
      )
      const output = buildWorkerInspectResponse(
        fetched.agent.status,
        worker,
        timeline.activity,
        activityFetched,
        timeline.lastMessage,
        includeLastMessage === true,
      )

      return {
        title: `Worker Inspect: ${args.workerId}`,
        output: JSON.stringify(output, null, 2),
      }
    },
  })
}

async function fetchAndStoreWorkerSnapshot(
  state: PluginState,
  client: PaseoTransport,
  workerId: string,
  onWorkerObserved?: WorkerRefreshObserver,
) {
  const fetched = await client.fetchWorker(workerId)
  if (!fetched) throw new Error(`Worker "${workerId}" not found`)
  const worker = mapAgentToWorkerSummary(fetched.agent)
  const existing = state.workers.get(workerId)
  if (existing) worker.unreadEventCount = existing.unreadEventCount
  upsertWorker(state, worker)
  onWorkerObserved?.(worker)
  return { fetched, worker }
}

async function fetchInspectTimeline(
  client: PaseoTransport,
  workerId: string,
  includeActivity: boolean,
  includeLastMessage: boolean,
  activityLimit: number | undefined,
  maxSummaryLength: number,
): Promise<WorkerInspectTimelineResult> {
  if (!includeActivity && !includeLastMessage) return { activity: null }

  if (!includeActivity) {
    return fetchInspectLastMessageOnly(client, workerId, maxSummaryLength)
  }

  if (!includeLastMessage) {
    return fetchInspectActivityOnly(client, workerId, activityLimit)
  }

  if (activityLimit !== undefined) {
    return fetchInspectTimelineWithSeparateMessageLookup(client, workerId, activityLimit, maxSummaryLength)
  }

  const activityResult = await client.fetchWorkerActivity({ workerId, includeLastMessage: true, maxSummaryLength })
  return {
    activity: activityResult.activity,
    lastMessage: activityResult.lastMessage ?? null,
  }
}

async function fetchInspectActivityOnly(
  client: PaseoTransport,
  workerId: string,
  activityLimit: number | undefined,
): Promise<WorkerInspectTimelineResult> {
  const activityResult = await client.fetchWorkerActivity({ workerId, ...compactDefined({ limit: activityLimit }) })
  return { activity: activityResult.activity }
}

async function fetchInspectLastMessageOnly(
  client: PaseoTransport,
  workerId: string,
  maxSummaryLength: number,
): Promise<WorkerInspectTimelineResult> {
  const activityResult = await client.fetchWorkerActivity({ workerId, includeLastMessage: true, maxSummaryLength })
  return {
    activity: null,
    lastMessage: activityResult.lastMessage ?? null,
  }
}

async function fetchInspectTimelineWithSeparateMessageLookup(
  client: PaseoTransport,
  workerId: string,
  activityLimit: number,
  maxSummaryLength: number,
): Promise<WorkerInspectTimelineResult> {
  const [activityResult, lastMessageResult] = await Promise.all([
    client.fetchWorkerActivity({ workerId, limit: activityLimit }),
    client.fetchWorkerActivity({ workerId, includeLastMessage: true, maxSummaryLength }),
  ])
  return {
    activity: activityResult.activity,
    lastMessage: lastMessageResult.lastMessage ?? null,
  }
}

function buildWorkerInspectResponse(
  rawAgentStatus: string | undefined,
  worker: WorkerSummary,
  activity: WorkerActivitySummary | null,
  activityFetched: boolean,
  lastMessage: WorkerLastMessage | null | undefined,
  includeLastMessage: boolean,
): WorkerInspectResponse {
  const activityState = deriveActivityState(worker, activity, activityFetched)
  return {
    worker: buildWorkerInspectSnapshot(rawAgentStatus, worker),
    attention: buildWorkerInspectAttention(worker),
    progress: buildWorkerInspectProgress(worker, activityState, activity, activityFetched),
    ...(activityFetched ? { activity } : {}),
    ...(includeLastMessage ? { lastMessage: lastMessage ?? null } : {}),
  }
}

function buildWorkerInspectSnapshot(
  rawAgentStatus: string | undefined,
  worker: WorkerSummary,
): WorkerInspectResponse["worker"] {
  return {
    id: worker.id,
    title: worker.title,
    status: worker.status,
    rawStatus: worker.rawStatus ?? rawAgentStatus ?? null,
    cwd: worker.cwd,
    provider: worker.provider,
    model: worker.model,
    currentModeId: worker.currentModeId,
    ...(worker.chatRoom !== undefined ? { chatRoom: worker.chatRoom } : {}),
    ...(worker.worktreePath !== undefined ? { worktreePath: worker.worktreePath } : {}),
    ...(worker.branchName !== undefined ? { branchName: worker.branchName } : {}),
    ...(worker.createdAt !== undefined ? { createdAt: worker.createdAt } : {}),
    ...(worker.updatedAt !== undefined ? { updatedAt: worker.updatedAt } : {}),
    source: "daemon",
  }
}

function buildWorkerInspectAttention(worker: WorkerSummary): WorkerInspectResponse["attention"] {
  return {
    pendingPermissionIds: worker.pendingPermissionIds,
    pendingPermissionCount: worker.pendingPermissions.length,
    blockingAction: getBlockingAction(worker),
    requiresAttention: worker.requiresAttention,
    attentionReason: worker.attentionReason,
  }
}

function buildWorkerInspectProgress(
  worker: WorkerSummary,
  activityState: InspectActivityState,
  activity: WorkerActivitySummary | null,
  activityFetched: boolean,
): WorkerInspectResponse["progress"] {
  const progress = deriveProgressSummary(worker, activityState, activity, activityFetched)
  return {
    activityState,
    summary: progress.summary,
    lastMeaningfulUpdate: progress.lastMeaningfulUpdate,
    readyForDependentWork: deriveReadyForDependentWork(worker.status),
  }
}
