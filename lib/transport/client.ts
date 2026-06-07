import { DaemonClient } from "@getpaseo/client"
import type { DaemonClientConfig, DaemonEvent as UpstreamDaemonEvent, ConnectionState } from "@getpaseo/client"
import packageJson from "../../package.json" with { type: "json" }
import type { DaemonConfig } from "../config.js"
import type {
  AgentSummary,
  FetchAgentsOptions,
  TerminalSummary,
  ServerInfo,
  DaemonEvent,
  DaemonEventCallback,
  PaseoTransport,
  CreateTerminalOptions,
  CreatedTerminal,
  CaptureTerminalOptions,
  TerminalCapture,
  KilledTerminal,
  RespondPermissionOptions,
  PermissionResponse,
  CreateWorkerOptions,
  CreatedWorker,
  RunWorkerOptions,
  CreateChatRoomOptions,
  ChatMessage,
  ChatMessageMutationResult,
  ChatReadResult,
  ChatRoomListResult,
  ChatRoomMutationResult,
  ChatRoomSummary,
  ChatWaitResult,
  DeleteChatRoomOptions,
  InspectChatRoomOptions,
  PostChatMessageOptions,
  ReadChatMessagesOptions,
  WorkerWaitResult,
  ArchivedWorker,
  WorkerInspectResult,
  UpdateWorkerOptions,
  WorkerUpdateResult,
  WorkerActivityOptions,
  WorkerActivityEntrySummary,
  WorkerActivityResult,
  WorkerActivitySummary,
  WorktreeListOptions,
  WorktreeCreateOptions,
  WorktreeArchiveOptions,
  WorktreeArchiveResult,
  WorktreeCreateResult,
  WorktreeListResult,
  ScheduleCreateOptions,
  ScheduleDeleteResult,
  ScheduleUpdateOptions,
  ScheduleInspectOptions,
  ScheduleListResult,
  LoopInspectOptions,
  LoopInspectResult,
  LoopListItem,
  LoopListResult,
  LoopLogEntry,
  LoopLogsOptions,
  LoopLogsResult,
  LoopRecord,
  LoopRunOptions,
  LoopRunResult,
  LoopStopOptions,
  LoopStopResult,
  LoopVerifyCheckResult,
  LoopVerifyPromptResult,
  LoopIterationRecord,
  ScheduleLogsResult,
  ScheduleMutationResult,
  ScheduleRecord,
  ScheduleRunRecord,
  WaitForChatMessagesOptions,
  WorktreeWorkspaceRecord,
} from "./types.js"

// ─── Paseo Client Adapter ─────────────────────────────────────────────────────
// Wraps @getpaseo/client DaemonClient and exposes the PaseoTransport interface
// that the rest of the plugin depends on. Translates upstream typed events into
// the normalized DaemonEvent shape used by the inbox and state layer.

const APP_VERSION = packageJson.version

type UpstreamTerminalExitEvent = {
  type: "terminal_stream_exit"
  payload: {
    terminalId: string
  }
}

// ─── Exported Pure Functions (for testing) ────────────────────────────────────

export function buildDaemonConfig(config: DaemonConfig): DaemonClientConfig {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host
  return {
    url: `ws://${host}:${config.port}/ws`,
    clientId: `opencode-paseo-${crypto.randomUUID()}`,
    clientType: "cli",
    appVersion: APP_VERSION,
    ...(config.password !== undefined ? { password: config.password } : {}),
    connectTimeoutMs: config.connectionTimeoutMs,
    reconnect: { enabled: false },
    suppressSendErrors: true,
  }
}

export function mapServerInfo(info: {
  serverId: string
  hostname?: string | null
  version?: string | null
  capabilities?: Record<string, unknown>
  features?: Record<string, boolean>
}): ServerInfo {
  return {
    serverId: info.serverId,
    ...(info.hostname != null ? { hostname: info.hostname } : {}),
    ...(info.version != null ? { version: info.version } : {}),
    features: info.features ?? {},
    capabilities: info.capabilities ?? {},
  }
}

export function mapAgentSnapshot(agent: Record<string, unknown>): AgentSummary {
  return {
    id: agent.id as string,
    provider: (agent.provider as string) ?? "unknown",
    cwd: (agent.cwd as string) ?? "",
    model: (agent.model as string | null) ?? null,
    status: (agent.status as string) ?? "unknown",
    title: (agent.title as string | null) ?? null,
    labels: agentLabels(agent),
    ...agentAttentionFields(agent),
    pendingPermissions: (agent.pendingPermissions as Array<Record<string, unknown>>) ?? [],
    capabilities: asRecord(agent.capabilities) ?? {},
    ...agentRuntimeFields(agent),
    ...agentTimestampFields(agent),
    ...agentWorktreeFields(agent),
  }
}

function agentLabels(agent: Record<string, unknown>): Record<string, string> {
  return (agent.labels ?? {}) as Record<string, string>
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined
}

function agentAttentionFields(agent: Record<string, unknown>): Partial<AgentSummary> {
  return {
    ...(typeof agent.requiresAttention === "boolean" ? { requiresAttention: agent.requiresAttention } : {}),
    ...(optionalStringOrNull(agent.attentionReason) !== undefined
      ? { attentionReason: optionalStringOrNull(agent.attentionReason) }
      : {}),
    ...(optionalStringOrNull(agent.attentionTimestamp) !== undefined
      ? { attentionTimestamp: optionalStringOrNull(agent.attentionTimestamp) }
      : {}),
  }
}

function agentRuntimeFields(agent: Record<string, unknown>): Partial<AgentSummary> {
  const runtimeInfo = asRecord(agent.runtimeInfo)
  return runtimeInfo !== null ? { runtimeInfo } : {}
}

function agentTimestampFields(agent: Record<string, unknown>): Partial<AgentSummary> {
  return {
    ...(typeof agent.createdAt === "string" ? { createdAt: agent.createdAt } : {}),
    ...(typeof agent.updatedAt === "string" ? { updatedAt: agent.updatedAt } : {}),
  }
}

function agentWorktreeFields(agent: Record<string, unknown>): Partial<AgentSummary> {
  const labels = agentLabels(agent)
  const worktreePath = (typeof agent.worktreePath === "string" ? agent.worktreePath : undefined) ?? labels.worktreePath
  const branchName = (typeof agent.branchName === "string" ? agent.branchName : undefined) ?? labels.branchName
  return {
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function getNestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    const currentRecord = asRecord(current)
    if (!currentRecord || !(key in currentRecord)) {
      return undefined
    }
    current = currentRecord[key]
  }
  return current
}

function firstString(value: unknown, maxLength = 160): string | null {
  if (typeof value === "string") {
    return normalizeSummaryString(value, maxLength)
  }

  if (Array.isArray(value)) {
    return firstStringInArray(value, maxLength)
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  return firstPreferredString(record, maxLength) ?? firstRecordString(record, maxLength)
}

function normalizeSummaryString(value: string, maxLength: number): string | null {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return null
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized
}

function firstStringInArray(values: unknown[], maxLength: number): string | null {
  for (const entry of values) {
    const found = firstString(entry, maxLength)
    if (found) return found
  }
  return null
}

function preferredSummaryPaths(): string[][] {
  return [
    ["summary"],
    ["title"],
    ["message"],
    ["text"],
    ["content"],
    ["reasoning"],
    ["payload", "summary"],
    ["payload", "message"],
    ["payload", "text"],
    ["payload", "content"],
    ["event", "summary"],
    ["event", "message"],
    ["event", "text"],
  ]
}

function firstPreferredString(record: Record<string, unknown>, maxLength: number): string | null {
  for (const path of preferredSummaryPaths()) {
    const found = firstString(getNestedValue(record, path), maxLength)
    if (found) return found
  }
  return null
}

function firstRecordString(record: Record<string, unknown>, maxLength: number): string | null {
  for (const key of Object.keys(record)) {
    const found = firstString(record[key], maxLength)
    if (found) return found
  }
  return null
}

function firstScalar(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function extractTimelineEntries(timeline: unknown): unknown[] {
  if (Array.isArray(timeline)) {
    return timeline
  }

  const record = asRecord(timeline)
  if (!record) {
    return []
  }

  for (const key of ["entries", "events", "items", "timeline", "activity"]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[]
    }
  }

  return []
}

function projectTimelineEntry(entry: unknown): WorkerActivityEntrySummary | null {
  if (typeof entry === "string") {
    return projectStringTimelineEntry(entry)
  }

  const record = asRecord(entry)
  if (!record) {
    return null
  }

  return projectRecordTimelineEntry(record)
}

function projectStringTimelineEntry(entry: string): WorkerActivityEntrySummary | null {
  const summary = firstString(entry)
  return summary ? { kind: "message", summary } : null
}

function projectRecordTimelineEntry(record: Record<string, unknown>): WorkerActivityEntrySummary {
  const kind =
    firstScalar(record, ["kind", "type", "eventType", "category"]) ??
    (record.toolName || record.tool ? "tool" : "event")
  const timestamp = firstScalar(record, ["timestamp", "createdAt", "updatedAt", "at"])
  const toolName = firstTimelineScalar(record, ["toolName", "tool", "name"])
  const status = firstTimelineScalar(record, ["status", "state", "result"])
  const summary = timelineSummary(record, kind, toolName, status)

  return {
    kind,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(status !== undefined ? { status } : {}),
    summary,
  }
}

function firstTimelineScalar(record: Record<string, unknown>, keys: string[]): string | undefined {
  return firstScalar(record, keys) ?? firstScalar(asRecord(record.event) ?? {}, keys)
}

function timelineSummary(
  record: Record<string, unknown>,
  kind: string,
  toolName: string | undefined,
  status: string | undefined,
): string {
  return (
    firstString(record.summary) ??
    firstString(record.payload) ??
    firstString(record.event) ??
    firstString(record) ??
    `${kind}${toolName ? ` ${toolName}` : ""}${status ? ` (${status})` : ""}`
  )
}

export function projectTimeline(timeline: unknown, requestedLimit?: number): WorkerActivitySummary {
  const entries = extractTimelineEntries(timeline)
    .map((entry) => projectTimelineEntry(entry))
    .filter((entry): entry is WorkerActivityEntrySummary => entry !== null)

  const record = asRecord(timeline)
  const explicitHasMore =
    typeof record?.hasMore === "boolean"
      ? record.hasMore
      : typeof record?.hasOlderEntries === "boolean"
        ? record.hasOlderEntries
        : typeof record?.remainingCount === "number"
          ? record.remainingCount > 0
          : undefined

  return {
    entries: entries.slice(0, requestedLimit ?? entries.length),
    hasMore: explicitHasMore ?? false,
  }
}

export function translateUpstreamEvent(event: UpstreamDaemonEvent | UpstreamTerminalExitEvent): DaemonEvent | null {
  switch (event.type) {
    case "agent_update":
      return translateAgentUpdateEvent(event)

    case "agent_stream":
      return translateAgentStreamEvent(event)

    case "agent_deleted":
      return {
        type: "agent_deleted",
        payload: { agentId: event.agentId },
      }

    case "terminal_stream_exit":
      return {
        type: "terminal.exited",
        payload: { terminalId: event.payload.terminalId },
      }

    case "agent_permission_request":
      return translatePermissionRequestEvent(event)

    case "agent_permission_resolved":
      return translatePermissionResolvedEvent(event)

    case "error":
      return {
        type: "daemon.error",
        payload: { message: event.message },
      }

    default:
      return null
  }
}

function translateAgentUpdateEvent(event: Extract<UpstreamDaemonEvent, { type: "agent_update" }>): DaemonEvent | null {
  const payload = event.payload as Record<string, unknown>
  if ((payload.kind as string | undefined) === "remove") {
    return { type: "agent_update", payload: { kind: "remove", agentId: event.agentId } }
  }

  const agent = payload.agent as Record<string, unknown> | undefined
  if (!agent) return null
  const mappedAgent = mapAgentSnapshot(agent)
  return {
    type: "agent_update",
    payload: {
      kind: "upsert",
      agentId: mappedAgent.id,
      agent: mappedAgent,
      ...("project" in payload ? { project: asRecord(payload.project) } : {}),
    },
  }
}

function translateAgentStreamEvent(event: Extract<UpstreamDaemonEvent, { type: "agent_stream" }>): DaemonEvent {
  const streamEvent = asRecord(event.event)
  const summary = firstString(streamEvent)
  return {
    type: "agent_stream",
    payload: {
      workerId: event.agentId,
      ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
      ...streamSubtypeField(streamEvent),
      ...(summary !== null ? { summary } : {}),
    },
  }
}

function streamSubtypeField(streamEvent: Record<string, unknown> | null): { subtype?: string } {
  const subtype =
    (typeof streamEvent?.type === "string" && streamEvent.type) ||
    (typeof streamEvent?.kind === "string" && streamEvent.kind) ||
    undefined
  return subtype !== undefined ? { subtype } : {}
}

function translatePermissionRequestEvent(
  event: Extract<UpstreamDaemonEvent, { type: "agent_permission_request" }>,
): DaemonEvent {
  const request = asRecord(event.request) ?? {}
  return {
    type: "agent_permission_request",
    payload: {
      workerId: event.agentId,
      ...(typeof request.id === "string" ? { permissionId: request.id } : {}),
      request,
    },
  }
}

function translatePermissionResolvedEvent(
  event: Extract<UpstreamDaemonEvent, { type: "agent_permission_resolved" }>,
): DaemonEvent {
  return {
    type: "agent_permission_resolved",
    payload: {
      workerId: event.agentId,
      permissionId: event.requestId,
      resolution: asRecord(event.resolution) ?? {},
    },
  }
}

function mapScheduleRun(run: Record<string, unknown>): ScheduleRunRecord {
  return {
    id: run.id as string,
    scheduledFor: run.scheduledFor as string,
    startedAt: run.startedAt as string,
    endedAt: (run.endedAt as string | null) ?? null,
    status: run.status as ScheduleRunRecord["status"],
    agentId: (run.agentId as string | null) ?? null,
    output: (run.output as string | null) ?? null,
    error: (run.error as string | null) ?? null,
  }
}

function mapChatRoom(room: Record<string, unknown>): ChatRoomSummary {
  return {
    id: room.id as string,
    name: room.name as string,
    purpose: (room.purpose as string | null) ?? null,
    createdAt: room.createdAt as string,
    updatedAt: room.updatedAt as string,
    messageCount: (room.messageCount as number) ?? 0,
    lastMessageAt: (room.lastMessageAt as string | null) ?? null,
  }
}

function mapChatMessage(message: Record<string, unknown>): ChatMessage {
  return {
    id: message.id as string,
    roomId: message.roomId as string,
    authorAgentId: message.authorAgentId as string,
    body: message.body as string,
    replyToMessageId: (message.replyToMessageId as string | null) ?? null,
    mentionAgentIds: (message.mentionAgentIds as string[]) ?? [],
    createdAt: message.createdAt as string,
  }
}

function mapChatRoomMutationResult(result: Record<string, unknown>): ChatRoomMutationResult {
  return {
    requestId: result.requestId as string,
    room: result.room ? mapChatRoom(result.room as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapChatRoomListResult(result: Record<string, unknown>): ChatRoomListResult {
  return {
    requestId: result.requestId as string,
    rooms: Array.isArray(result.rooms) ? result.rooms.map((room) => mapChatRoom(room as Record<string, unknown>)) : [],
    error: (result.error as string | null) ?? null,
  }
}

function mapChatMessageMutationResult(result: Record<string, unknown>): ChatMessageMutationResult {
  return {
    requestId: result.requestId as string,
    message: result.message ? mapChatMessage(result.message as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapChatReadResult(result: Record<string, unknown>): ChatReadResult {
  return {
    requestId: result.requestId as string,
    messages: Array.isArray(result.messages)
      ? result.messages.map((message) => mapChatMessage(message as Record<string, unknown>))
      : [],
    error: (result.error as string | null) ?? null,
  }
}

function mapChatWaitResult(result: Record<string, unknown>): ChatWaitResult {
  return {
    requestId: result.requestId as string,
    messages: Array.isArray(result.messages)
      ? result.messages.map((message) => mapChatMessage(message as Record<string, unknown>))
      : [],
    timedOut: Boolean(result.timedOut),
    error: (result.error as string | null) ?? null,
  }
}

function mapLoopVerifyCheckResult(result: Record<string, unknown>): LoopVerifyCheckResult {
  return {
    ...result,
    command: (result.command as string | undefined) ?? undefined,
    ok: result.ok as boolean | undefined,
    exitCode: (result.exitCode as number | null | undefined) ?? undefined,
    output: (result.output as string | null | undefined) ?? undefined,
    error: (result.error as string | null | undefined) ?? undefined,
  }
}

function mapLoopVerifyPromptResult(result: Record<string, unknown>): LoopVerifyPromptResult {
  return {
    ...result,
    ok: result.ok as boolean | undefined,
    response: (result.response as string | null | undefined) ?? undefined,
    error: (result.error as string | null | undefined) ?? undefined,
  }
}

function mapLoopIteration(iteration: Record<string, unknown>): LoopIterationRecord {
  return {
    ...iteration,
    iteration: (iteration.iteration as number | undefined) ?? undefined,
    status: (iteration.status as string | undefined) ?? undefined,
    startedAt: (iteration.startedAt as string | undefined) ?? undefined,
    endedAt: (iteration.endedAt as string | null | undefined) ?? undefined,
    error: (iteration.error as string | null | undefined) ?? undefined,
    verifyPromptResult: iteration.verifyPromptResult
      ? mapLoopVerifyPromptResult(iteration.verifyPromptResult as Record<string, unknown>)
      : undefined,
    verifyCheckResults: Array.isArray(iteration.verifyCheckResults)
      ? iteration.verifyCheckResults.map((result) => mapLoopVerifyCheckResult(result as Record<string, unknown>))
      : undefined,
  }
}

function mapLoopListItem(loop: Record<string, unknown>): LoopListItem {
  return {
    ...loop,
    id: loop.id as string,
    name: (loop.name as string | null | undefined) ?? undefined,
    prompt: (loop.prompt as string | undefined) ?? undefined,
    cwd: (loop.cwd as string | undefined) ?? undefined,
    status: (loop.status as string | undefined) ?? undefined,
    createdAt: (loop.createdAt as string | undefined) ?? undefined,
    updatedAt: (loop.updatedAt as string | undefined) ?? undefined,
    error: (loop.error as string | null | undefined) ?? undefined,
  }
}

function mapLoopRecord(loop: Record<string, unknown>): LoopRecord {
  return {
    ...mapLoopListItem(loop),
    stoppedAt: (loop.stoppedAt as string | null | undefined) ?? undefined,
    iterations: Array.isArray(loop.iterations)
      ? loop.iterations.map((iteration) => mapLoopIteration(iteration as Record<string, unknown>))
      : [],
  }
}

function mapLoopLogEntry(entry: Record<string, unknown>): LoopLogEntry {
  return {
    ...entry,
    seq: entry.seq as number,
    source: (entry.source as string | undefined) ?? undefined,
    level: (entry.level as string | undefined) ?? undefined,
    text: (entry.text as string) ?? "",
  }
}

function mapLoopRunResult(result: Record<string, unknown>): LoopRunResult {
  return {
    requestId: result.requestId as string,
    loop: result.loop ? mapLoopRecord(result.loop as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapLoopListResult(result: Record<string, unknown>): LoopListResult {
  return {
    requestId: result.requestId as string,
    loops: Array.isArray(result.loops)
      ? result.loops.map((loop) => mapLoopListItem(loop as Record<string, unknown>))
      : [],
    error: (result.error as string | null) ?? null,
  }
}

function mapLoopInspectResult(result: Record<string, unknown>): LoopInspectResult {
  return {
    requestId: result.requestId as string,
    loop: result.loop ? mapLoopRecord(result.loop as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapLoopLogsResult(result: Record<string, unknown>): LoopLogsResult {
  return {
    requestId: result.requestId as string,
    loop: result.loop ? mapLoopRecord(result.loop as Record<string, unknown>) : null,
    entries: Array.isArray(result.entries)
      ? result.entries.map((entry) => mapLoopLogEntry(entry as Record<string, unknown>))
      : [],
    nextCursor: (result.nextCursor as number | null | undefined) ?? null,
    error: (result.error as string | null) ?? null,
  }
}

function mapLoopStopResult(result: Record<string, unknown>): LoopStopResult {
  return {
    requestId: result.requestId as string,
    loop: result.loop ? mapLoopRecord(result.loop as Record<string, unknown>) : null,
    stopped: (result.stopped as boolean | undefined) ?? undefined,
    error: (result.error as string | null) ?? null,
  }
}

function mapScheduleRecord(schedule: Record<string, unknown>): ScheduleRecord {
  return {
    id: schedule.id as string,
    name: (schedule.name as string | null) ?? null,
    prompt: schedule.prompt as string,
    cadence: schedule.cadence as ScheduleRecord["cadence"],
    target: schedule.target as ScheduleRecord["target"],
    status: schedule.status as ScheduleRecord["status"],
    createdAt: schedule.createdAt as string,
    updatedAt: schedule.updatedAt as string,
    nextRunAt: (schedule.nextRunAt as string | null) ?? null,
    lastRunAt: (schedule.lastRunAt as string | null) ?? null,
    pausedAt: (schedule.pausedAt as string | null) ?? null,
    expiresAt: (schedule.expiresAt as string | null) ?? null,
    maxRuns: (schedule.maxRuns as number | null) ?? null,
    runs: Array.isArray(schedule.runs)
      ? schedule.runs.map((run) => mapScheduleRun(run as Record<string, unknown>))
      : [],
  }
}

function mapScheduleMutationResult(result: Record<string, unknown>): ScheduleMutationResult {
  return {
    requestId: result.requestId as string,
    schedule: result.schedule ? mapScheduleRecord(result.schedule as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapScheduleListResult(result: Record<string, unknown>): ScheduleListResult {
  return {
    requestId: result.requestId as string,
    schedules: Array.isArray(result.schedules)
      ? result.schedules.map((schedule) => mapScheduleRecord(schedule as Record<string, unknown>))
      : [],
    error: (result.error as string | null) ?? null,
  }
}

function mapScheduleDeleteResult(result: Record<string, unknown>): ScheduleDeleteResult {
  return {
    requestId: result.requestId as string,
    scheduleId: result.scheduleId as string,
    error: (result.error as string | null) ?? null,
  }
}

function mapScheduleLogsResult(result: Record<string, unknown>): ScheduleLogsResult {
  return {
    requestId: result.requestId as string,
    runs: Array.isArray(result.runs) ? result.runs.map((run) => mapScheduleRun(run as Record<string, unknown>)) : [],
    error: (result.error as string | null) ?? null,
  }
}

function mapWorktreeWorkspace(workspace: Record<string, unknown>): WorktreeWorkspaceRecord {
  return {
    id: workspace.id as string,
    projectId: workspace.projectId as string,
    projectDisplayName: workspace.projectDisplayName as string,
    projectCustomName: (workspace.projectCustomName as string | null) ?? undefined,
    projectRootPath: workspace.projectRootPath as string,
    workspaceDirectory: workspace.workspaceDirectory as string,
    projectKind: workspace.projectKind as WorktreeWorkspaceRecord["projectKind"],
    workspaceKind: workspace.workspaceKind as WorktreeWorkspaceRecord["workspaceKind"],
    name: workspace.name as string,
    archivingAt: (workspace.archivingAt as string | null) ?? null,
    status: workspace.status as WorktreeWorkspaceRecord["status"],
    activityAt: (workspace.activityAt as string | null) ?? null,
    diffStat: (workspace.diffStat as WorktreeWorkspaceRecord["diffStat"]) ?? undefined,
    scripts: (workspace.scripts as WorktreeWorkspaceRecord["scripts"]) ?? [],
    gitRuntime: (workspace.gitRuntime as WorktreeWorkspaceRecord["gitRuntime"]) ?? undefined,
    githubRuntime: (workspace.githubRuntime as WorktreeWorkspaceRecord["githubRuntime"]) ?? undefined,
  }
}

function mapWorktreeListResult(result: Record<string, unknown>): WorktreeListResult {
  return {
    requestId: result.requestId as string,
    worktrees: (result.worktrees as WorktreeListResult["worktrees"]) ?? [],
    error: (result.error as WorktreeListResult["error"]) ?? null,
  }
}

function mapWorktreeCreateResult(result: Record<string, unknown>): WorktreeCreateResult {
  return {
    requestId: result.requestId as string,
    workspace: result.workspace ? mapWorktreeWorkspace(result.workspace as Record<string, unknown>) : null,
    error: (result.error as string | null) ?? null,
  }
}

function mapWorktreeArchiveResult(result: Record<string, unknown>): WorktreeArchiveResult {
  return {
    requestId: result.requestId as string,
    success: Boolean(result.success),
    removedAgents: (result.removedAgents as string[] | undefined) ?? undefined,
    error: (result.error as WorktreeArchiveResult["error"]) ?? null,
  }
}

function buildWorkerMetadataUpdate(
  options: UpdateWorkerOptions,
): { name?: string; labels?: Record<string, string> } | null {
  if (options.name === undefined && options.labels === undefined) return null
  return {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
  }
}

// ─── PaseoClient Class ────────────────────────────────────────────────────────

export class PaseoClient implements PaseoTransport {
  private daemon: DaemonClient
  private serverInfo: ServerInfo | null = null
  private eventListeners: DaemonEventCallback[] = []
  private unsubscribes: Array<() => void> = []

  constructor(config: DaemonConfig) {
    this.daemon = new DaemonClient(buildDaemonConfig(config))
  }

  // ─── Connection ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.daemon.connect()

    const info = this.daemon.getLastServerInfoMessage()
    if (info) {
      this.serverInfo = mapServerInfo(info)
    }

    const connUnsub = this.daemon.subscribeConnectionStatus((status: ConnectionState) => {
      if (status.status === "connected") {
        const refreshed = this.daemon.getLastServerInfoMessage()
        if (refreshed) {
          this.serverInfo = mapServerInfo(refreshed)
        }
        this.notifyEvent({ type: "daemon.connected", payload: {} })
      } else if (status.status === "disconnected") {
        this.serverInfo = null
        this.notifyEvent({ type: "daemon.disconnected", payload: {} })
      }
    })
    this.unsubscribes.push(connUnsub)

    const eventUnsub = this.daemon.subscribe((event: UpstreamDaemonEvent) => {
      const translated = translateUpstreamEvent(event)
      if (translated) {
        this.notifyEvent(translated)
      }
    })
    this.unsubscribes.push(eventUnsub)
  }

  async close(): Promise<void> {
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []
    this.serverInfo = null
    await this.daemon.close()
  }

  isConnected(): boolean {
    return this.daemon.isConnected
  }

  getServerInfo(): ServerInfo | null {
    return this.serverInfo
  }

  // ─── Data Fetching ───────────────────────────────────────────────────

  async fetchAgents(options?: FetchAgentsOptions): Promise<AgentSummary[]> {
    const result = await this.daemon.fetchAgents(options)
    return (result.entries ?? []).map((entry) => mapAgentSnapshot(entry.agent as unknown as Record<string, unknown>))
  }

  async listTerminals(cwd?: string): Promise<TerminalSummary[]> {
    const result = await this.daemon.listTerminals(cwd)
    return (result.terminals ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      title: t.title,
    }))
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const result = await this.daemon.getDaemonStatus()
    return result
  }

  async getProvidersSnapshot(cwd?: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.daemon.getProvidersSnapshot({ cwd })
    return result.entries ?? []
  }

  // ─── Terminal Operations ─────────────────────────────────────────────

  async createTerminal(options: CreateTerminalOptions): Promise<CreatedTerminal> {
    const result = await this.daemon.createTerminal(options.cwd, options.name, undefined, {
      agentId: options.agentId,
    })
    const terminal = result.terminal
    if (!terminal) {
      throw new Error("Daemon returned no terminal for createTerminal request")
    }
    return {
      id: terminal.id,
      name: terminal.name,
      title: terminal.title ?? undefined,
      cwd: terminal.cwd,
    }
  }

  async captureTerminal(options: CaptureTerminalOptions): Promise<TerminalCapture> {
    const result = await this.daemon.captureTerminal(options.terminalId, {
      start: options.start,
      end: options.end,
      stripAnsi: options.stripAnsi,
    })
    return {
      terminalId: result.terminalId,
      lines: result.lines,
      totalLines: result.totalLines,
    }
  }

  sendTerminalInput(terminalId: string, input: string): void {
    this.daemon.sendTerminalInput(terminalId, { type: "input", data: input })
  }

  async killTerminal(terminalId: string): Promise<KilledTerminal> {
    const result = await this.daemon.killTerminal(terminalId)
    return {
      id: result.terminalId,
      exitCode: result.success ? 0 : null,
    }
  }

  // ─── Permission Operations ───────────────────────────────────────────

  async respondToPermission(options: RespondPermissionOptions): Promise<PermissionResponse> {
    const response =
      options.behavior === "allow"
        ? {
            behavior: "allow" as const,
            selectedActionId: options.selectedActionId,
          }
        : {
            behavior: "deny" as const,
            message: options.message,
            interrupt: options.interrupt,
            selectedActionId: options.selectedActionId,
          }
    await this.daemon.respondToPermission(options.workerId, options.permissionId, response)
    return {
      workerId: options.workerId,
      permissionId: options.permissionId,
      behavior: options.behavior,
    }
  }

  // ─── Chat Operations ─────────────────────────────────────────────────

  async createChatRoom(options: CreateChatRoomOptions): Promise<ChatRoomMutationResult> {
    const result = await this.daemon.createChatRoom(options)
    return mapChatRoomMutationResult(result)
  }

  async listChatRooms(): Promise<ChatRoomListResult> {
    const result = await this.daemon.listChatRooms()
    return mapChatRoomListResult(result)
  }

  async inspectChatRoom(options: InspectChatRoomOptions): Promise<ChatRoomMutationResult> {
    const result = await this.daemon.inspectChatRoom(options)
    return mapChatRoomMutationResult(result)
  }

  async deleteChatRoom(options: DeleteChatRoomOptions): Promise<ChatRoomMutationResult> {
    const result = await this.daemon.deleteChatRoom(options)
    return mapChatRoomMutationResult(result)
  }

  async postChatMessage(options: PostChatMessageOptions): Promise<ChatMessageMutationResult> {
    const result = await this.daemon.postChatMessage(options)
    return mapChatMessageMutationResult(result)
  }

  async readChatMessages(options: ReadChatMessagesOptions): Promise<ChatReadResult> {
    const result = await this.daemon.readChatMessages(options)
    return mapChatReadResult(result)
  }

  async waitForChatMessages(options: WaitForChatMessagesOptions): Promise<ChatWaitResult> {
    const result = await this.daemon.waitForChatMessages(options)
    return mapChatWaitResult(result)
  }

  // ─── Worker Operations ───────────────────────────────────────────────

  private buildWorkerCreatePayload(
    options: CreateWorkerOptions,
    lifecycle: { background: boolean; detached: boolean },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      provider: options.provider,
      cwd: options.cwd,
      initialPrompt: options.initialPrompt,
      labels: options.labels,
      worktree: options.worktree,
      worktreeName: options.worktreeName,
      background: lifecycle.background,
      detached: lifecycle.detached,
    }

    if (options.model || options.modeId) {
      payload.config = {
        ...(options.model ? { model: options.model } : {}),
        ...(options.modeId ? { modeId: options.modeId } : {}),
      }
    }

    return payload
  }

  async createWorker(options: CreateWorkerOptions): Promise<CreatedWorker> {
    // Assemble the daemon create-agent payload.
    // background/detached are always forced to true: the plugin creates workers
    // that must run independently of the current session lifecycle.
    // The installed @getpaseo/client CreateAgentRequestOptions does not expose
    // these fields in its typed surface, so they are injected via the
    // Record<string, unknown> escape hatch that the daemon client already accepts.
    const payload = this.buildWorkerCreatePayload(options, {
      background: true,
      detached: true,
    })

    const snapshot = await this.daemon.createAgent(payload)
    const mapped = mapAgentSnapshot(snapshot)
    return {
      id: mapped.id,
      provider: mapped.provider,
      cwd: mapped.cwd,
      model: mapped.model,
      status: mapped.status,
      title: mapped.title,
    }
  }

  async runWorker(options: RunWorkerOptions): Promise<CreatedWorker> {
    const payload = this.buildWorkerCreatePayload(options, {
      background: options.background ?? false,
      detached: false,
    })

    const snapshot = await this.daemon.createAgent(payload)
    const mapped = mapAgentSnapshot(snapshot)
    return {
      id: mapped.id,
      provider: mapped.provider,
      cwd: mapped.cwd,
      model: mapped.model,
      status: mapped.status,
      title: mapped.title,
    }
  }

  async sendWorkerMessage(workerId: string, message: string): Promise<void> {
    await this.daemon.sendAgentMessage(workerId, message)
  }

  async waitForWorker(workerId: string, timeout: number): Promise<WorkerWaitResult> {
    const result = await this.daemon.waitForFinish(workerId, timeout)
    return {
      status: result.status,
      workerId,
      error: result.error,
      lastMessage: result.lastMessage,
      finalSnapshot: result.final ? mapAgentSnapshot(result.final) : null,
    }
  }

  async cancelWorker(workerId: string): Promise<void> {
    await this.daemon.cancelAgent(workerId)
  }

  async archiveWorker(workerId: string): Promise<ArchivedWorker> {
    const result = await this.daemon.archiveAgent(workerId)
    return {
      workerId,
      archivedAt: result.archivedAt,
    }
  }

  async fetchWorker(workerId: string): Promise<WorkerInspectResult | null> {
    let result: Awaited<ReturnType<typeof this.daemon.fetchAgent>>
    try {
      result = await this.daemon.fetchAgent(workerId)
    } catch (err: unknown) {
      // Upstream fetchAgent throws "Agent not found" instead of returning null
      if (err instanceof Error && err.message.includes("not found")) {
        return null
      }
      throw err
    }
    if (!result) {
      return null
    }
    return {
      agent: mapAgentSnapshot(result.agent),
      project: result.project ?? null,
    }
  }

  async killWorker(workerId: string): Promise<void> {
    // Upstream has no dedicated kill; cancelAgent is the closest permanent stop.
    await this.daemon.cancelAgent(workerId)
  }

  async updateWorker(options: UpdateWorkerOptions): Promise<WorkerUpdateResult> {
    const errors: string[] = []
    const metadataUpdated = await this.updateWorkerMetadata(options, errors)
    const settingsUpdated = await this.updateWorkerSettings(options, errors)

    return {
      workerId: options.workerId,
      updated: metadataUpdated || settingsUpdated,
      metadataUpdated,
      settingsUpdated,
      errors,
    }
  }

  private async updateWorkerMetadata(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    const updates = buildWorkerMetadataUpdate(options)
    if (!updates) return false
    return this.runUpdateStep("metadata update", errors, async () => {
      await this.daemon.updateAgent(options.workerId, updates)
    })
  }

  private async updateWorkerSettings(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    if (!options.settings) return false
    let updated = false
    updated = (await this.updateWorkerMode(options, errors)) || updated
    updated = (await this.updateWorkerModel(options, errors)) || updated
    updated = (await this.updateWorkerThinkingOption(options, errors)) || updated
    updated = (await this.updateWorkerFeatures(options, errors)) || updated
    return updated
  }

  private async updateWorkerMode(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    if (options.settings?.modeId === undefined) return false
    return this.runUpdateStep("setAgentMode", errors, async () => {
      await this.daemon.setAgentMode(options.workerId, options.settings!.modeId!)
    })
  }

  private async updateWorkerModel(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    if (options.settings?.model === undefined) return false
    return this.runUpdateStep("setAgentModel", errors, async () => {
      await this.daemon.setAgentModel(options.workerId, options.settings!.model!)
    })
  }

  private async updateWorkerThinkingOption(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    if (options.settings?.thinkingOptionId === undefined) return false
    return this.runUpdateStep("setAgentThinkingOption", errors, async () => {
      await this.daemon.setAgentThinkingOption(options.workerId, options.settings!.thinkingOptionId!)
    })
  }

  private async updateWorkerFeatures(options: UpdateWorkerOptions, errors: string[]): Promise<boolean> {
    const features = options.settings?.features
    if (!features) return false
    let updated = false
    for (const [featureId, value] of Object.entries(features)) {
      updated =
        (await this.runUpdateStep(`setAgentFeature(${featureId})`, errors, async () => {
          await this.daemon.setAgentFeature(options.workerId, featureId, value)
        })) || updated
    }
    return updated
  }

  private async runUpdateStep(label: string, errors: string[], update: () => Promise<void>): Promise<boolean> {
    try {
      await update()
      return true
    } catch (err: unknown) {
      errors.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  async fetchWorkerActivity(options: WorkerActivityOptions): Promise<WorkerActivityResult> {
    try {
      const timeline = await this.daemon.fetchAgentTimeline(options.workerId, {
        limit: options.limit,
      })
      return {
        workerId: options.workerId,
        activity: projectTimeline(timeline, options.limit),
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        return { workerId: options.workerId, activity: null }
      }
      throw err
    }
  }

  // ─── Worktree Operations ─────────────────────────────────────────────

  async listWorktrees(options: WorktreeListOptions): Promise<WorktreeListResult> {
    const result = await this.daemon.getPaseoWorktreeList({
      cwd: options.cwd,
      repoRoot: options.repoRoot,
    })
    return mapWorktreeListResult(result)
  }

  async createWorktree(options: WorktreeCreateOptions): Promise<WorktreeCreateResult> {
    const input: Record<string, unknown> = { cwd: options.cwd }
    if (options.projectId !== undefined) input.projectId = options.projectId
    if (options.worktreeSlug !== undefined) input.worktreeSlug = options.worktreeSlug
    if (options.refName !== undefined) input.refName = options.refName
    if (options.action !== undefined) input.action = options.action
    if (options.githubPrNumber !== undefined) input.githubPrNumber = options.githubPrNumber
    if (options.firstAgentContext !== undefined) input.firstAgentContext = options.firstAgentContext
    const result = await this.daemon.createPaseoWorktree(input as Parameters<typeof this.daemon.createPaseoWorktree>[0])
    return mapWorktreeCreateResult(result)
  }

  async archiveWorktree(options: WorktreeArchiveOptions): Promise<WorktreeArchiveResult> {
    const result = await this.daemon.archivePaseoWorktree({
      worktreePath: options.worktreePath,
      repoRoot: options.cwd,
    })
    return mapWorktreeArchiveResult(result)
  }

  // ─── Loop Operations ─────────────────────────────────────────────────

  async loopRun(options: LoopRunOptions): Promise<LoopRunResult> {
    const result = await this.daemon.loopRun({
      prompt: options.prompt,
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      modeId: options.modeId,
      verifierProvider: options.verifierProvider,
      verifierModel: options.verifierModel,
      verifierModeId: options.verifierModeId,
      verifyPrompt: options.verifyPrompt,
      verifyChecks: options.verifyChecks,
      name: options.name,
      sleepMs: options.sleepMs,
      maxIterations: options.maxIterations,
      maxTimeMs: options.maxTimeMs,
    })
    return mapLoopRunResult(result)
  }

  async loopList(): Promise<LoopListResult> {
    const result = await this.daemon.loopList()
    return mapLoopListResult(result)
  }

  async loopInspect(options: LoopInspectOptions): Promise<LoopInspectResult> {
    const result = await this.daemon.loopInspect({ id: options.id })
    return mapLoopInspectResult(result)
  }

  async loopLogs(options: LoopLogsOptions): Promise<LoopLogsResult> {
    const result = await this.daemon.loopLogs({ id: options.id, afterSeq: options.afterSeq })
    return mapLoopLogsResult(result)
  }

  async loopStop(options: LoopStopOptions): Promise<LoopStopResult> {
    const result = await this.daemon.loopStop({ id: options.id })
    return mapLoopStopResult(result)
  }

  // ─── Schedule Operations ─────────────────────────────────────────────

  async scheduleList(): Promise<ScheduleListResult> {
    const result = await this.daemon.scheduleList()
    return mapScheduleListResult(result)
  }

  async scheduleInspect(options: ScheduleInspectOptions): Promise<ScheduleMutationResult> {
    const result = await this.daemon.scheduleInspect({ id: options.id })
    return mapScheduleMutationResult(result)
  }

  async scheduleCreate(options: ScheduleCreateOptions): Promise<ScheduleMutationResult> {
    const result = await this.daemon.scheduleCreate({
      prompt: options.prompt,
      name: options.name,
      cadence: options.cadence,
      target: options.target,
      maxRuns: options.maxRuns,
      expiresAt: options.expiresAt,
      runOnCreate: options.runOnCreate,
    })
    return mapScheduleMutationResult(result)
  }

  async scheduleUpdate(options: ScheduleUpdateOptions): Promise<ScheduleMutationResult> {
    const result = await this.daemon.scheduleUpdate({
      id: options.id,
      name: options.name,
      prompt: options.prompt,
      cadence: options.cadence,
      newAgentConfig: options.newAgentConfig,
      maxRuns: options.maxRuns,
      expiresAt: options.expiresAt,
    })
    return mapScheduleMutationResult(result)
  }

  async schedulePause(options: ScheduleInspectOptions): Promise<ScheduleMutationResult> {
    const result = await this.daemon.schedulePause({ id: options.id })
    return mapScheduleMutationResult(result)
  }

  async scheduleResume(options: ScheduleInspectOptions): Promise<ScheduleMutationResult> {
    const result = await this.daemon.scheduleResume({ id: options.id })
    return mapScheduleMutationResult(result)
  }

  async scheduleDelete(options: ScheduleInspectOptions): Promise<ScheduleDeleteResult> {
    const result = await this.daemon.scheduleDelete({ id: options.id })
    return mapScheduleDeleteResult(result)
  }

  async scheduleRunOnce(options: ScheduleInspectOptions): Promise<ScheduleMutationResult> {
    try {
      const result = await this.daemon.scheduleRunOnce({ id: options.id })
      return mapScheduleMutationResult(result)
    } catch (err: unknown) {
      if (err instanceof Error && /Timeout waiting for message \(10000ms\)/.test(err.message)) {
        return {
          requestId: `schedule-run-once-timeout-${crypto.randomUUID()}`,
          schedule: null,
          error: null,
          dispatched: true,
          async: true,
          warning:
            `${err.message}. The run may still have been dispatched asynchronously; ` +
            `use paseo_schedule_logs to confirm the outcome.`,
          nextStep: "paseo_schedule_logs",
        }
      }
      throw err
    }
  }

  async scheduleLogs(options: ScheduleInspectOptions): Promise<ScheduleLogsResult> {
    const result = await this.daemon.scheduleLogs({ id: options.id })
    return mapScheduleLogsResult(result)
  }

  // ─── Event Subscription ──────────────────────────────────────────────

  onEvent(callback: DaemonEventCallback): () => void {
    this.eventListeners.push(callback)
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== callback)
    }
  }

  // ─── Internal: Event Dispatch ────────────────────────────────────────

  private notifyEvent(event: DaemonEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // Listener errors should not break the event loop
      }
    }
  }
}
