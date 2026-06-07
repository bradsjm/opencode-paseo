import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState, WorkerSummary } from "../state/types.js"
import type { Logger } from "../logger.js"
import type { CreatedWorker, PaseoTransport, WorkerWaitResult } from "../transport/types.js"
import type { OpencodeClient, ProfileSummary } from "../profile.js"
import { listProfiles, profileToWorkerFields, resolveProfile } from "../profile.js"
import {
  findTaskRunByWorkerId,
  getOrCreateSession,
  getTaskRun,
  recordBackgroundWorker,
  recordCreatedWorker,
  recordTaskRun,
  registerEphemeralWorkerRun,
  removeEphemeralWorkerRun,
  unrecordBackgroundWorker,
} from "../state/state.js"
import { mergePaseoParentAgentLabel } from "../parent-agent-label.js"
import { TASK_COMPLETION_INJECTED_LABEL, TASK_DEFERRED_LABEL, getTaskLabelInfo, taskRunLabels } from "../task-labels.js"
import { renderTaskOutput } from "../task-output.js"

const DEFAULT_TASK_WAIT_TIMEOUT_MS = 30_000
const TASK_WAIT_SLICE_TIMEOUT_MS = 250

const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "Do not poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "Do not poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

export const TASK_TOOL_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Grep tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead, to find the match more quickly
- If no available agent is a good fit for the task, use other tools directly

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when the result is ready.
3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.
4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
5. The agent's outputs should generally be trusted
6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).
7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.`

type TaskArgs = {
  description: string
  prompt: string
  subagent_type: string
  task_id?: string
  command?: string
  background?: boolean
}

interface TaskExecutionContext {
  description: string
  prompt: string
  subagentType: string
  runInBackground: boolean
  profile: ProfileSummary
  model: { providerID: string; modelID: string }
  taskSessionId: string
  workerId: string
  createdWorker: CreatedWorker
  resumed: boolean
}

interface TaskMarkerSnapshot {
  background: boolean
  completionInjected?: boolean
  labels?: Record<string, string>
}

export function createTaskTool(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
): ToolDefinition {
  return tool({
    description: TASK_TOOL_DESCRIPTION,
    args: {
      description: tool.schema.string().describe("A short (3-5 words) description of the task"),
      prompt: tool.schema.string().describe("The task for the agent to perform"),
      subagent_type: tool.schema.string().describe("The type of specialized agent to use for this task"),
      task_id: tool.schema
        .string()
        .optional()
        .describe(
          "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
        ),
      command: tool.schema.string().optional().describe("The command that triggered this task"),
      background: tool.schema
        .boolean()
        .optional()
        .describe("Run the agent in the background. You will be notified when it completes."),
    },
    async execute(args: TaskArgs, context: ToolContext) {
      await context.ask({
        permission: "task",
        patterns: [args.subagent_type],
        always: ["*"],
        metadata: {
          description: args.description,
          subagent_type: args.subagent_type,
        },
      })

      const task = await resolveTaskExecution(state, client, opencodeClient, logger, args, context)
      const metadata = taskMetadata(context.sessionID, task)
      context.metadata({ title: args.description, metadata })

      if (task.runInBackground) {
        await markTaskWorkerDeferred(state, client, logger, task.workerId)
        watchBackgroundTaskCompletion(state, client, opencodeClient, logger, task.workerId)
        return taskBackgroundResponse(task, metadata)
      }

      return waitForTaskForeground(state, client, opencodeClient, logger, context, task, metadata)
    },
  })
}

async function resolveTaskExecution(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  args: TaskArgs,
  context: ToolContext,
): Promise<TaskExecutionContext> {
  const profile = await resolveTaskProfile(opencodeClient, context.directory, args.subagent_type)
  const model = taskModel(profile)
  const existing = await resolveExistingTask(state, client, args.task_id)
  if (existing) {
    await mirrorTaskPrompt(opencodeClient, logger, existing.taskSessionId, args.prompt, context.directory)
    const markerSnapshot = await prepareTaskResume(state, client, logger, existing.workerId, args.background === true)
    try {
      await client.sendWorkerMessage(existing.workerId, args.prompt)
    } catch (err: unknown) {
      await rollbackTaskResumeMarkers(state, client, logger, existing.workerId, markerSnapshot)
      throw err
    }
    logger.info("Tool: task resumed via Paseo", { taskSessionId: existing.taskSessionId, workerId: existing.workerId })
    const createdWorker = workerFromExisting(existing.workerId, context.directory, profile)
    return {
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagent_type,
      runInBackground: args.background === true,
      profile,
      model,
      taskSessionId: existing.taskSessionId,
      workerId: existing.workerId,
      createdWorker,
      resumed: true,
    }
  }

  return launchNewTask(state, client, opencodeClient, logger, args, context, profile, model)
}

async function prepareTaskResume(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  workerId: string,
  runInBackground: boolean,
): Promise<TaskMarkerSnapshot | undefined> {
  const taskRun = findTaskRunByWorkerId(state, workerId)
  if (!taskRun) return undefined
  const snapshot: TaskMarkerSnapshot = {
    background: taskRun.background,
    completionInjected: taskRun.completionInjected,
    ...(taskRun.labels !== undefined ? { labels: { ...taskRun.labels } } : {}),
  }
  const labels = { ...(taskRun.labels ?? {}) }
  delete labels[TASK_COMPLETION_INJECTED_LABEL]
  if (runInBackground) labels[TASK_DEFERRED_LABEL] = "true"
  else delete labels[TASK_DEFERRED_LABEL]
  const result = await client.updateWorker({ workerId, labels })
  if (result.errors.length > 0) {
    const message = `Failed to persist task resume markers: ${result.errors.join("; ")}`
    logger.warn(message, { workerId, errors: result.errors })
    throw new Error(message)
  }
  taskRun.background = runInBackground
  taskRun.completionInjected = false
  taskRun.labels = labels
  setTaskBackgroundOwnership(state, taskRun, runInBackground)
  return snapshot
}

async function rollbackTaskResumeMarkers(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  workerId: string,
  snapshot: TaskMarkerSnapshot | undefined,
): Promise<void> {
  if (!snapshot) return
  const taskRun = findTaskRunByWorkerId(state, workerId)
  if (!taskRun) return
  const labels = snapshot.labels ?? {}
  const result = await client.updateWorker({ workerId, labels })
  if (result.errors.length > 0) {
    logger.warn("Failed to roll back task resume markers", { workerId, errors: result.errors })
    return
  }
  taskRun.background = snapshot.background
  taskRun.completionInjected = snapshot.completionInjected
  taskRun.labels = snapshot.labels
  setTaskBackgroundOwnership(state, taskRun, snapshot.background)
}

async function resolveTaskProfile(
  opencodeClient: OpencodeClient,
  cwd: string,
  subagentType: string,
): Promise<ProfileSummary> {
  return resolveProfile(await listProfiles(opencodeClient, cwd), subagentType)
}

function taskModel(profile: ProfileSummary): { providerID: string; modelID: string } {
  return {
    providerID: profile.providerID ?? "opencode",
    modelID: profile.modelID ?? "default",
  }
}

async function resolveExistingTask(state: PluginState, client: PaseoTransport, taskId: string | undefined) {
  if (!taskId) return null
  const local = getTaskRun(state, taskId)
  if (local) return local
  const agents = await client.fetchAgents(undefined)
  const match = agents.find((agent) => getTaskLabelInfo(agent.labels)?.taskSessionId === taskId)
  if (!match) return null
  const info = getTaskLabelInfo(match.labels)
  if (!info) return null
  const record = {
    taskSessionId: info.taskSessionId,
    parentSessionId: info.parentSessionId,
    workerId: match.id,
    description: info.description ?? match.title ?? taskId,
    subagentType: info.subagentType ?? match.provider,
    background: info.deferred === true && !info.completionInjected,
    completionInjected: info.completionInjected,
    labels: match.labels,
    createdAt: Date.now(),
  }
  recordTaskRun(state, record)
  return record
}

async function launchNewTask(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  args: TaskArgs,
  context: ToolContext,
  profile: ProfileSummary,
  model: { providerID: string; modelID: string },
): Promise<TaskExecutionContext> {
  const sessionResult = await opencodeClient.session.create({
    body: {
      parentID: context.sessionID,
      title: `${args.description} (@${args.subagent_type} paseo task)`,
    },
    query: { directory: context.directory },
  })
  if (!sessionResult.data) throw new Error("Failed to create task child session")
  const taskSessionId = sessionResult.data.id
  await mirrorTaskPrompt(opencodeClient, logger, taskSessionId, args.prompt, context.directory)
  const workerFields = profileToWorkerFields(profile)
  const labels = mergePaseoParentAgentLabel({
    ...taskRunLabels({
      taskSessionId,
      parentSessionId: context.sessionID,
      description: args.description,
      subagentType: args.subagent_type,
    }),
    ...(args.background === true ? { [TASK_DEFERRED_LABEL]: "true" } : {}),
  })

  const createdWorker = await client.runWorker({
    cwd: context.directory,
    provider: workerFields.provider,
    modeId: workerFields.modeId,
    initialPrompt: args.prompt,
    background: args.background === true,
    ...(workerFields.model ? { model: workerFields.model } : {}),
    labels,
  })

  const worker = workerSummaryFromCreated(createdWorker, profile)
  getOrCreateSession(state, taskSessionId, context.worktree ?? context.directory)
  getOrCreateSession(state, context.sessionID, context.worktree ?? context.directory)
  recordCreatedWorker(state, taskSessionId, worker)
  recordCreatedWorker(state, context.sessionID, worker)
  recordTaskRun(state, {
    taskSessionId,
    parentSessionId: context.sessionID,
    workerId: createdWorker.id,
    description: args.description,
    subagentType: args.subagent_type,
    background: args.background === true,
    labels,
    createdAt: Date.now(),
  })
  const taskRun = getTaskRun(state, taskSessionId)
  if (taskRun) setTaskBackgroundOwnership(state, taskRun, args.background === true)
  registerEphemeralWorkerRun(state, taskSessionId, createdWorker.id, { background: args.background === true })
  logger.info("Tool: task launched via Paseo", { taskSessionId, workerId: createdWorker.id })

  return {
    description: args.description,
    prompt: args.prompt,
    subagentType: args.subagent_type,
    runInBackground: args.background === true,
    profile,
    model,
    taskSessionId,
    workerId: createdWorker.id,
    createdWorker,
    resumed: false,
  }
}

function workerSummaryFromCreated(createdWorker: CreatedWorker, profile: ProfileSummary): WorkerSummary {
  return {
    id: createdWorker.id,
    title: createdWorker.title ?? createdWorker.model ?? createdWorker.id,
    agent: createdWorker.provider,
    status: createdWorker.status === "initializing" ? "initializing" : "running",
    rawStatus: createdWorker.status,
    cwd: createdWorker.cwd,
    provider: createdWorker.provider,
    model: createdWorker.model,
    currentModeId: profile.name,
    labels: [],
    pendingPermissions: [],
    pendingPermissionIds: [],
    requiresAttention: false,
    attentionReason: null,
    runtimeInfo: null,
    persistence: null,
    unreadEventCount: 0,
  }
}

function workerFromExisting(workerId: string, cwd: string, profile: ProfileSummary): CreatedWorker {
  return {
    id: workerId,
    cwd,
    provider: "opencode",
    model: profile.modelID,
    status: "running",
    title: workerId,
  }
}

function taskMetadata(parentSessionId: string, task: TaskExecutionContext) {
  return {
    parentSessionId,
    sessionId: task.taskSessionId,
    model: task.model,
    paseoWorkerId: task.workerId,
    ...(task.runInBackground ? { background: true, jobId: task.taskSessionId } : {}),
  }
}

function taskBackgroundResponse(task: TaskExecutionContext, metadata: Record<string, unknown>) {
  return {
    title: task.description,
    metadata,
    output: renderTaskOutput({
      sessionID: task.taskSessionId,
      state: "running",
      summary: task.resumed ? "Background task updated" : "Background task started",
      text: task.resumed ? BACKGROUND_UPDATED : BACKGROUND_STARTED,
    }),
  }
}

async function mirrorTaskPrompt(
  opencodeClient: OpencodeClient,
  logger: Logger,
  taskSessionId: string,
  prompt: string,
  directory: string,
): Promise<void> {
  try {
    await opencodeClient.session.promptAsync({
      path: { id: taskSessionId },
      query: { directory },
      body: {
        noReply: true,
        parts: [{ type: "text", synthetic: true, text: prompt }],
      },
    })
  } catch (err: unknown) {
    logger.warn("Failed to mirror task prompt into child session", {
      taskSessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function watchBackgroundTaskCompletion(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  workerId: string,
): void {
  if (state.taskCompletionWatchers.has(workerId)) return
  state.taskCompletionWatchers.add(workerId)
  void waitForBackgroundTaskCompletion(client, workerId)
    .then((result) => {
      if (result.status === "error") {
        return notifyTaskCompletion(
          state,
          client,
          opencodeClient,
          logger,
          workerId,
          "error",
          result.error ?? "Task failed",
        )
      }
      return notifyTaskCompletion(state, client, opencodeClient, logger, workerId, "completed", resultText(result))
    })
    .catch((err: unknown) => {
      logger.warn("Failed while waiting for background task completion", {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      state.taskCompletionWatchers.delete(workerId)
    })
}

async function waitForBackgroundTaskCompletion(client: PaseoTransport, workerId: string): Promise<WorkerWaitResult> {
  while (true) {
    const result = await client.waitForWorker(workerId, DEFAULT_TASK_WAIT_TIMEOUT_MS)
    if (result.status !== "timeout" && result.status !== "permission") return result
  }
}

async function waitForTaskForeground(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  context: ToolContext,
  task: TaskExecutionContext,
  metadata: Record<string, unknown>,
) {
  const abortState = setupAbort(client, logger, context, task.workerId)
  try {
    const result = await pollTaskWorker(client, task.workerId, abortState)
    if (result === "aborted") return taskAbortedResponse(task, metadata)
    if (result.status === "timeout") {
      await markTaskWorkerDeferred(state, client, logger, task.workerId)
      watchBackgroundTaskCompletion(state, client, opencodeClient, logger, task.workerId)
      return taskTimedOutResponse(task, metadata)
    }
    if (result.status === "permission") {
      await markTaskWorkerDeferred(state, client, logger, task.workerId)
      watchBackgroundTaskCompletion(state, client, opencodeClient, logger, task.workerId)
      return taskPermissionResponse(task, metadata)
    }
    if (result.status === "error") return taskErrorResponse(task, metadata, result.error ?? "Task failed")
    return taskCompletedResponse(state, client, opencodeClient, logger, task, metadata, result)
  } finally {
    context.abort.removeEventListener("abort", abortState.onAbort)
    removeEphemeralWorkerRun(state, task.workerId)
  }
}

async function markTaskWorkerDeferred(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  workerId: string,
): Promise<void> {
  const taskRun = findTaskRunByWorkerId(state, workerId)
  if (!taskRun) return
  const labels = { ...(taskRun.labels ?? {}), [TASK_DEFERRED_LABEL]: "true" }
  const result = await client.updateWorker({ workerId, labels })
  if (result.errors.length > 0) {
    const message = `Failed to persist task deferred marker: ${result.errors.join("; ")}`
    logger.warn(message, { workerId, errors: result.errors })
    throw new Error(message)
  }
  taskRun.background = true
  taskRun.labels = labels
  setTaskBackgroundOwnership(state, taskRun, true)
}

function setTaskBackgroundOwnership(
  state: PluginState,
  taskRun: { taskSessionId: string; parentSessionId: string; workerId: string },
  background: boolean,
): void {
  const update = background ? recordBackgroundWorker : unrecordBackgroundWorker
  update(state, taskRun.taskSessionId, taskRun.workerId)
  update(state, taskRun.parentSessionId, taskRun.workerId)
}

function setupAbort(client: PaseoTransport, logger: Logger, context: ToolContext, workerId: string) {
  let cancelIssued = false
  let resolveAbort: (() => void) | undefined
  const abortPromise = new Promise<"aborted">((resolve) => {
    resolveAbort = () => resolve("aborted")
  })
  const onAbort = () => {
    if (!cancelIssued) {
      cancelIssued = true
      void client.cancelWorker(workerId).catch((err: unknown) => {
        logger.warn("Failed to cancel task worker after abort", {
          workerId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    resolveAbort?.()
  }
  if (context.abort.aborted) onAbort()
  else context.abort.addEventListener("abort", onAbort, { once: true })
  return { abortPromise, onAbort }
}

async function pollTaskWorker(
  client: PaseoTransport,
  workerId: string,
  abortState: { abortPromise: Promise<"aborted"> },
): Promise<WorkerWaitResult | "aborted"> {
  const deadline = Date.now() + DEFAULT_TASK_WAIT_TIMEOUT_MS
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { status: "timeout", workerId, error: null, lastMessage: null, finalSnapshot: null }
    }
    const sliceTimeout = Math.min(TASK_WAIT_SLICE_TIMEOUT_MS, remaining)
    const result = await Promise.race([client.waitForWorker(workerId, sliceTimeout), abortState.abortPromise])
    if (result === "aborted") return result
    if (result.status !== "timeout") return result
  }
}

async function taskCompletedResponse(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  task: TaskExecutionContext,
  metadata: Record<string, unknown>,
  result: WorkerWaitResult,
) {
  const text = resultText(result)
  await injectTaskResult(
    opencodeClient,
    task.taskSessionId,
    task,
    "completed",
    text,
    `Task completed: ${task.description}`,
  )
  await persistTaskCompletionMarker(state, client, logger, task.workerId)
  return {
    title: task.description,
    metadata,
    output: renderTaskOutput({ sessionID: task.taskSessionId, state: "completed", text }),
  }
}

function taskErrorResponse(task: TaskExecutionContext, metadata: Record<string, unknown>, text: string) {
  return {
    title: task.description,
    metadata,
    output: renderTaskOutput({ sessionID: task.taskSessionId, state: "error", text }),
  }
}

function taskAbortedResponse(task: TaskExecutionContext, metadata: Record<string, unknown>) {
  return taskErrorResponse(task, metadata, "Task cancelled")
}

function taskPermissionResponse(task: TaskExecutionContext, metadata: Record<string, unknown>) {
  return {
    title: task.description,
    metadata: { ...metadata, background: true, jobId: task.taskSessionId },
    output: renderTaskOutput({
      sessionID: task.taskSessionId,
      state: "running",
      summary: "Task waiting for permission",
      text: `Task is waiting for a permission response. Reuse task_id ${task.taskSessionId} to continue the same Paseo-backed task after responding.`,
    }),
  }
}

function taskTimedOutResponse(task: TaskExecutionContext, metadata: Record<string, unknown>) {
  return {
    title: task.description,
    metadata: { ...metadata, background: true, jobId: task.taskSessionId },
    output: renderTaskOutput({
      sessionID: task.taskSessionId,
      state: "running",
      summary: "Task still running",
      text: `Task did not finish before the foreground wait timeout. Reuse task_id ${task.taskSessionId} to continue the same Paseo-backed task.`,
    }),
  }
}

function resultText(result: WorkerWaitResult): string {
  return result.lastMessage ?? result.error ?? JSON.stringify(result, null, 2)
}

export async function notifyTaskCompletion(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient | undefined,
  logger: Logger,
  workerId: string,
  status: "completed" | "error",
  text: string,
): Promise<void> {
  const taskRun = findTaskRunByWorkerId(state, workerId)
  if (!taskRun || !opencodeClient) return
  try {
    await Promise.all([
      injectTaskResult(
        opencodeClient,
        taskRun.parentSessionId,
        taskRun,
        status,
        text,
        backgroundTaskSummary(taskRun.description, status),
      ),
      injectTaskResult(
        opencodeClient,
        taskRun.taskSessionId,
        taskRun,
        status,
        text,
        backgroundTaskSummary(taskRun.description, status),
      ),
    ])
    await persistTaskCompletionMarker(state, client, logger, workerId)
  } catch (err: unknown) {
    logger.warn("Failed to inject background task result", {
      workerId,
      taskSessionId: taskRun.taskSessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function persistTaskCompletionMarker(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
  workerId: string,
): Promise<void> {
  const taskRun = findTaskRunByWorkerId(state, workerId)
  if (!taskRun) return
  const labels = { ...(taskRun.labels ?? {}), [TASK_COMPLETION_INJECTED_LABEL]: "true" }
  const result = await client.updateWorker({ workerId, labels })
  if (result.errors.length > 0) {
    logger.warn("Failed to persist task completion marker", { workerId, errors: result.errors })
    return
  }
  taskRun.background = false
  taskRun.completionInjected = true
  taskRun.labels = labels
  setTaskBackgroundOwnership(state, taskRun, false)
}

async function injectTaskResult(
  opencodeClient: OpencodeClient,
  sessionId: string,
  taskRun: { taskSessionId: string; description: string },
  status: "completed" | "error",
  text: string,
  summary: string,
): Promise<void> {
  await opencodeClient.session.promptAsync({
    path: { id: sessionId },
    body: {
      noReply: true,
      parts: [
        {
          type: "text" as const,
          synthetic: true,
          text: renderTaskOutput({
            sessionID: taskRun.taskSessionId,
            state: status,
            summary,
            text,
          }),
        },
      ],
    },
  })
}

function backgroundTaskSummary(description: string, status: "completed" | "error"): string {
  return status === "completed" ? `Background task completed: ${description}` : `Background task failed: ${description}`
}
