// ─── Plugin-Owned Transport Types ─────────────────────────────────────────────
// These types represent the plugin's view of the daemon, not the wire protocol.
// The adapter in client.ts maps upstream @getpaseo/client types into these shapes.

// ─── Server Info ──────────────────────────────────────────────────────────────

/** Normalized daemon server metadata exposed to the plugin. */
export interface ServerInfo {
  serverId: string
  hostname?: string
  version?: string
  features: Record<string, boolean>
  capabilities: Record<string, unknown>
}

// ─── Agent Summary ────────────────────────────────────────────────────────────
// Mapped from upstream AgentSnapshotPayload.

/** Normalized worker snapshot used throughout the plugin state layer. */
export interface AgentSummary {
  id: string
  provider: string
  cwd: string
  model: string | null
  status: string
  title: string | null
  labels: Record<string, string>
  requiresAttention?: boolean
  attentionReason?: string | null
  attentionTimestamp?: string | null
  pendingPermissions?: Array<Record<string, unknown>>
  capabilities?: Record<string, unknown>
  runtimeInfo?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  worktreePath?: string
  branchName?: string
  [key: string]: unknown
}

// ─── Terminal Summary ─────────────────────────────────────────────────────────
// Mapped from upstream ListTerminalsPayload terminals.

/** Compact terminal summary returned by list operations. */
export interface TerminalSummary {
  id: string
  name: string
  title?: string
}

/** Event emitted when a terminal exits. */
export interface TerminalExitedEvent {
  type: "terminal.exited"
  payload: {
    terminalId: string
  }
}

// ─── Phase 3 Worker Types ─────────────────────────────────────────────────────
// Plugin-level shapes for worker (agent) mutation and inspection.

/** Options for creating a new worker agent. */
export interface CreateWorkerOptions {
  cwd: string
  profile?: string
  provider?: string
  model?: string | null
  modeId?: string
  initialPrompt?: string
  labels?: Record<string, string>
  worktree?: Record<string, unknown>
  worktreeName?: string
}

/** Options for running a worker agent with optional background execution. */
export interface RunWorkerOptions extends CreateWorkerOptions {
  background?: boolean
}

/** Normalized worker record returned after creation or run requests. */
export interface CreatedWorker {
  id: string
  provider: string
  cwd: string
  model: string | null
  status: string
  title: string | null
}

/** Result of waiting for a worker to finish. */
export interface WorkerWaitResult {
  status: "idle" | "error" | "permission" | "timeout"
  workerId: string
  error: string | null
  lastMessage: string | null
  finalSnapshot: AgentSummary | null
}

/** Summary of the event that nudged a worker wait operation. */
export interface WorkerWaitNudgeEvent {
  kind: "worker.stalled" | "agent.status" | "agent.attention" | "chat.mentioned" | "permission.requested"
  workerId: string
  summary: string
}

/** Normalized summary for a chat room. */
export interface ChatRoomSummary {
  id: string
  name: string
  purpose: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
  lastMessageAt: string | null
}

/** Normalized chat message representation used by the plugin. */
export interface ChatMessage {
  id: string
  roomId: string
  authorAgentId: string
  body: string
  replyToMessageId: string | null
  mentionAgentIds: string[]
  createdAt: string
}

/** Options for creating a chat room. */
export interface CreateChatRoomOptions {
  name: string
  purpose?: string | null
}

/** Options for inspecting a chat room. */
export interface InspectChatRoomOptions {
  room: string
}

/** Options for deleting a chat room. */
export interface DeleteChatRoomOptions {
  room: string
}

/** Options for posting a chat message. */
export interface PostChatMessageOptions {
  room: string
  body: string
  authorAgentId?: string
  replyToMessageId?: string | null
}

/** Options for reading chat messages. */
export interface ReadChatMessagesOptions {
  room: string
  limit?: number
  since?: string
  authorAgentId?: string
}

/** Options for waiting on new chat messages. */
export interface WaitForChatMessagesOptions {
  room: string
  afterMessageId?: string | null
  timeoutMs?: number
}

/** Result returned after mutating a chat room. */
export interface ChatRoomMutationResult {
  requestId: string
  room: ChatRoomSummary | null
  error: string | null
}

/** Result returned by chat room list operations. */
export interface ChatRoomListResult {
  requestId: string
  rooms: ChatRoomSummary[]
  error: string | null
}

/** Result returned after mutating a chat message. */
export interface ChatMessageMutationResult {
  requestId: string
  message: ChatMessage | null
  error: string | null
}

/** Result returned by chat message read operations. */
export interface ChatReadResult {
  requestId: string
  messages: ChatMessage[]
  error: string | null
}

/** Result returned by chat message wait operations. */
export interface ChatWaitResult {
  requestId: string
  messages: ChatMessage[]
  timedOut: boolean
  error: string | null
}

/** Aggregated result for waiting on multiple workers. */
export interface MultiWorkerWaitResult {
  waitFor: "any" | "all"
  workerIds: string[]
  results: WorkerWaitResult[]
  pendingWorkerIds: string[]
  interruptedByNudge: boolean
  nudgeEvent?: WorkerWaitNudgeEvent
  timedOut: boolean
}

/** Record describing an archived worker. */
export interface ArchivedWorker {
  workerId: string
  archivedAt: string
}

/** Result returned when inspecting a worker. */
export interface WorkerInspectResult {
  agent: AgentSummary
  project: Record<string, unknown> | null
}

// ─── Phase 3 Worktree Types ───────────────────────────────────────────────────

/** Options for listing worktrees. */
export interface WorktreeListOptions {
  cwd?: string
  repoRoot?: string
}

/** Options for creating a worktree. */
export interface WorktreeCreateOptions {
  cwd: string
  projectId?: string
  worktreeSlug?: string
  refName?: string
  action?: string
  githubPrNumber?: number
  firstAgentContext?: Record<string, unknown>
}

/** Options for archiving a worktree. */
export interface WorktreeArchiveOptions {
  worktreePath: string
  cwd: string
}

// ─── Phase 2 Result Types ─────────────────────────────────────────────────────
// Plugin-level shapes returned by terminal and permission operations.

/** Normalized terminal record returned after creation. */
export interface CreatedTerminal {
  id: string
  name: string
  title?: string
  cwd?: string
}

/** Captured terminal output and metadata. */
export interface TerminalCapture {
  terminalId: string
  lines: string[]
  totalLines: number
}

/** Result returned after terminating a terminal. */
export interface KilledTerminal {
  id: string
  exitCode?: number | null
}

/** Result returned after responding to a permission request. */
export interface PermissionResponse {
  workerId: string
  permissionId: string
  behavior: "allow" | "deny"
}

/** Options for creating a terminal session. */
export interface CreateTerminalOptions {
  cwd: string
  name?: string
  agentId?: string
}

/** Options for capturing terminal output. */
export interface CaptureTerminalOptions {
  terminalId: string
  start?: number
  end?: number
  stripAnsi?: boolean
}

/** Options for responding to a permission request. */
export interface RespondPermissionOptions {
  workerId: string
  permissionId: string
  behavior: "allow" | "deny"
  message?: string
  interrupt?: boolean
  selectedActionId?: string
}

// ─── Loop Types ───────────────────────────────────────────────────────────────
// Plugin-level shapes for daemon-native loop operations.

/** Single daemon loop log entry. */
export interface LoopLogEntry extends Record<string, unknown> {
  seq: number
  source?: string
  level?: string
  text: string
}

/** Result of a single loop verification check. */
export interface LoopVerifyCheckResult extends Record<string, unknown> {
  command?: string
  ok?: boolean
  exitCode?: number | null
  output?: string | null
  error?: string | null
}

/** Result of a loop verification prompt. */
export interface LoopVerifyPromptResult extends Record<string, unknown> {
  ok?: boolean
  response?: string | null
  error?: string | null
}

/** Captures the observed state for one loop iteration. */
export interface LoopIterationRecord extends Record<string, unknown> {
  iteration?: number
  status?: string
  startedAt?: string
  endedAt?: string | null
  error?: string | null
  verifyPromptResult?: LoopVerifyPromptResult | null
  verifyCheckResults?: LoopVerifyCheckResult[]
}

/** Summary of a loop returned by list operations. */
export interface LoopListItem extends Record<string, unknown> {
  id: string
  name?: string | null
  prompt?: string
  cwd?: string
  status?: string
  createdAt?: string
  updatedAt?: string
  error?: string | null
}

/** Full loop record including iteration history. */
export interface LoopRecord extends LoopListItem {
  stoppedAt?: string | null
  iterations: LoopIterationRecord[]
}

/** Options for starting a daemon loop. */
export interface LoopRunOptions {
  prompt: string
  cwd: string
  provider?: string
  model?: string
  modeId?: string
  verifierProvider?: string
  verifierModel?: string
  verifierModeId?: string
  verifyPrompt?: string
  verifyChecks?: string[]
  name?: string
  sleepMs?: number
  maxIterations?: number
  maxTimeMs?: number
}

/** Options for inspecting a loop. */
export interface LoopInspectOptions {
  id: string
}

/** Options for reading loop logs. */
export interface LoopLogsOptions extends LoopInspectOptions {
  afterSeq?: number
}

/** Options for stopping a loop. */
export type LoopStopOptions = LoopInspectOptions

/** Result returned after starting a loop. */
export interface LoopRunResult {
  requestId: string
  loop: LoopRecord | null
  error: string | null
}

/** Result returned by loop list operations. */
export interface LoopListResult {
  requestId: string
  loops: LoopListItem[]
  error: string | null
}

/** Result returned by loop inspection operations. */
export interface LoopInspectResult {
  requestId: string
  loop: LoopRecord | null
  error: string | null
}

/** Result returned by loop log queries. */
export interface LoopLogsResult {
  requestId: string
  loop: LoopRecord | null
  entries: LoopLogEntry[]
  nextCursor: number | null
  error: string | null
}

/** Result returned after stopping a loop. */
export interface LoopStopResult {
  requestId: string
  loop: LoopRecord | null
  stopped?: boolean
  error: string | null
}

// ─── Schedule Types ───────────────────────────────────────────────────────────
// Plugin-level shapes for schedule operations (thin wrappers over daemon RPCs).

/** Schedule cadence supported by the transport layer. */
export type ScheduleCadence =
  | { type: "every"; everyMs: number }
  | { type: "cron"; expression: string; timezone?: string }

/** Configuration used when a schedule spawns a new agent. */
export interface ScheduleNewAgentConfig {
  provider: string
  cwd: string
  modeId?: string
  model?: string
}

/** Schedule target that binds to an existing agent. */
export interface ScheduleTargetAgent {
  type: "agent"
  agentId: string
}

/** Schedule target that creates a new agent. */
export interface ScheduleTargetNewAgent {
  type: "new-agent"
  config: ScheduleNewAgentConfig
}

/** Schedule target union accepted by schedule operations. */
export type ScheduleTarget = ScheduleTargetAgent | ScheduleTargetNewAgent

/** Record describing a single schedule run. */
export interface ScheduleRunRecord {
  id: string
  scheduledFor: string
  startedAt: string
  endedAt: string | null
  status: "running" | "succeeded" | "failed"
  agentId: string | null
  output: string | null
  error: string | null
}

/** Full schedule record including cadence, target, and run history. */
export interface ScheduleRecord {
  id: string
  name: string | null
  prompt: string
  cadence: ScheduleCadence
  target: ScheduleTarget
  status: "active" | "paused" | "completed"
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  pausedAt: string | null
  expiresAt: string | null
  maxRuns: number | null
  runs: ScheduleRunRecord[]
}

/** Result returned after mutating a schedule. */
export interface ScheduleMutationResult {
  requestId: string
  schedule: ScheduleRecord | null
  error: string | null
  dispatched?: boolean
  async?: boolean
  warning?: string
  nextStep?: string
}

/** Result returned by schedule list operations. */
export interface ScheduleListResult {
  requestId: string
  schedules: ScheduleRecord[]
  error: string | null
}

/** Result returned after deleting a schedule. */
export interface ScheduleDeleteResult {
  requestId: string
  scheduleId: string
  error: string | null
}

/** Result returned by schedule log queries. */
export interface ScheduleLogsResult {
  requestId: string
  runs: ScheduleRunRecord[]
  error: string | null
}

/** Options for creating a schedule. */
export interface ScheduleCreateOptions {
  prompt: string
  name?: string
  cadence: ScheduleCadence
  target: ScheduleTarget
  maxRuns?: number
  expiresAt?: string
  runOnCreate?: boolean
}

/** Options for updating a schedule. */
export interface ScheduleUpdateOptions {
  id: string
  name?: string
  prompt?: string
  cadence?: ScheduleCadence
  newAgentConfig?: {
    provider?: string
    model?: string | null
    modeId?: string | null
    cwd?: string
  }
  maxRuns?: number
  expiresAt?: string
}

/** Options for inspecting a schedule. */
export interface ScheduleInspectOptions {
  id: string
}

// ─── Worker Update Types ──────────────────────────────────────────────────────

/** Settings that can be applied to an existing worker. */
export interface WorkerUpdateSettings {
  modeId?: string
  model?: string | null
  thinkingOptionId?: string | null
  features?: Record<string, unknown>
}

/** Options for updating a worker. */
export interface UpdateWorkerOptions {
  workerId: string
  name?: string
  labels?: Record<string, string>
  settings?: WorkerUpdateSettings
}

/** Result returned after updating a worker. */
export interface WorkerUpdateResult {
  workerId: string
  updated: boolean
  metadataUpdated: boolean
  settingsUpdated: boolean
  errors: string[]
}

// ─── Worker Activity Types ────────────────────────────────────────────────────

/** Options for fetching worker activity. */
export interface WorkerActivityOptions {
  workerId: string
  limit?: number
  includeLastMessage?: boolean
  maxSummaryLength?: number
}

/** Latest assistant/final message projected for inspect output. */
export interface WorkerLastMessage {
  role: "assistant"
  text: string
  timestamp: string | null
  truncated: boolean
}

/** Summary for a single worker activity entry. */
export interface WorkerActivityEntrySummary {
  kind: string
  timestamp?: string
  toolName?: string
  status?: string
  summary: string
}

/** Normalized worker activity timeline returned by the transport layer. */
export interface WorkerActivitySummary {
  entries: WorkerActivityEntrySummary[]
  hasMore: boolean
}

/** Result returned by worker activity queries. */
export interface WorkerActivityResult {
  workerId: string
  activity: WorkerActivitySummary | null
  lastMessage?: WorkerLastMessage | null
}

// ─── Normalized Daemon Event ──────────────────────────────────────────────────
// The adapter translates upstream DaemonClient events into this shape
// before delivering them to plugin consumers.

/** Payload for worker-related normalized daemon events. */
export interface WorkerEventPayload extends Record<string, unknown> {
  workerId: string
  summary?: string
}

/** Payload carried by normalized agent update events. */
export type AgentUpdatePayload =
  | {
      kind: "upsert"
      agentId: string
      agent: AgentSummary
      project?: Record<string, unknown> | null
    }
  | {
      kind: "remove"
      agentId: string
    }

/** Payload carried by normalized worker activity events. */
export interface WorkerActivityPayload extends Record<string, unknown> {
  workerId: string
  timestamp?: string
  subtype?: string
  summary?: string
}

/** Payload carried by normalized permission request events. */
export interface PermissionRequestedPayload extends Record<string, unknown> {
  workerId: string
  permissionId?: string
  request: Record<string, unknown>
}

/** Payload carried by normalized permission resolution events. */
export interface PermissionResolvedPayload extends Record<string, unknown> {
  workerId: string
  permissionId: string
  resolution: Record<string, unknown>
}

/** Normalized event emitted when the daemon connects. */
export interface DaemonConnectedEvent {
  type: "daemon.connected"
  payload: Record<string, never>
}

/** Normalized event emitted when the daemon disconnects. */
export interface DaemonDisconnectedEvent {
  type: "daemon.disconnected"
  payload: Record<string, never>
}

/** Normalized daemon error event. */
export interface DaemonErrorEvent {
  type: "daemon.error"
  payload: { message: string }
}

/** Upstream agent update event preserved for translation. */
export interface AgentUpdateEvent {
  type: "agent_update"
  payload: AgentUpdatePayload
}

/** Upstream agent deletion event preserved for translation. */
export interface AgentDeletedEvent {
  type: "agent_deleted"
  payload: { agentId: string }
}

/** Normalized event emitted when a worker stalls. */
export interface WorkerStalledEvent {
  type: "worker.stalled"
  payload: WorkerEventPayload
}

/** Upstream worker activity stream event preserved for translation. */
export interface WorkerActivityEvent {
  type: "agent_stream"
  payload: WorkerActivityPayload
}

/** Upstream permission request event preserved for translation. */
export interface PermissionRequestedEvent {
  type: "agent_permission_request"
  payload: PermissionRequestedPayload
}

/** Upstream permission resolution event preserved for translation. */
export interface PermissionResolvedEvent {
  type: "agent_permission_resolved"
  payload: PermissionResolvedPayload
}

/** Normalized event union emitted to plugin consumers. */
export type DaemonEvent =
  | DaemonConnectedEvent
  | DaemonDisconnectedEvent
  | DaemonErrorEvent
  | TerminalExitedEvent
  | AgentUpdateEvent
  | AgentDeletedEvent
  | WorkerStalledEvent
  | WorkerActivityEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent

/** Callback invoked for normalized daemon events. */
export type DaemonEventCallback = (event: DaemonEvent) => void

// ─── Fetch Agents Options ─────────────────────────────────────────────────────

/** Options for fetching agents from the daemon. */
export interface FetchAgentsOptions {
  subscribe?: { subscriptionId: string }
}

// ─── Transport Contract ───────────────────────────────────────────────────────
// The minimal interface the plugin needs from a Paseo daemon connection.

/** Transport contract implemented by the Paseo daemon client adapter. */
export interface PaseoTransport {
  connect(): Promise<void>
  close(): Promise<void>
  isConnected(): boolean
  getServerInfo(): ServerInfo | null
  fetchAgents(options?: FetchAgentsOptions): Promise<AgentSummary[]>
  listTerminals(cwd?: string): Promise<TerminalSummary[]>
  getStatus(): Promise<Record<string, unknown>>
  getProvidersSnapshot(cwd?: string): Promise<Array<Record<string, unknown>>>
  onEvent(callback: DaemonEventCallback): () => void

  // Phase 2: Terminal operations
  createTerminal(options: CreateTerminalOptions): Promise<CreatedTerminal>
  captureTerminal(options: CaptureTerminalOptions): Promise<TerminalCapture>
  sendTerminalInput(terminalId: string, input: string): void
  killTerminal(terminalId: string): Promise<KilledTerminal>

  // Phase 2: Permission operations
  respondToPermission(options: RespondPermissionOptions): Promise<PermissionResponse>

  // Chat operations
  createChatRoom(options: CreateChatRoomOptions): Promise<ChatRoomMutationResult>
  listChatRooms(): Promise<ChatRoomListResult>
  inspectChatRoom(options: InspectChatRoomOptions): Promise<ChatRoomMutationResult>
  deleteChatRoom(options: DeleteChatRoomOptions): Promise<ChatRoomMutationResult>
  postChatMessage(options: PostChatMessageOptions): Promise<ChatMessageMutationResult>
  readChatMessages(options: ReadChatMessagesOptions): Promise<ChatReadResult>
  waitForChatMessages(options: WaitForChatMessagesOptions): Promise<ChatWaitResult>

  // Phase 3: Worker operations
  createWorker(options: CreateWorkerOptions): Promise<CreatedWorker>
  runWorker(options: RunWorkerOptions): Promise<CreatedWorker>
  sendWorkerMessage(workerId: string, message: string): Promise<void>
  waitForWorker(workerId: string, timeout: number): Promise<WorkerWaitResult>
  cancelWorker(workerId: string): Promise<void>
  killWorker(workerId: string): Promise<void>
  archiveWorker(workerId: string): Promise<ArchivedWorker>
  fetchWorker(workerId: string): Promise<WorkerInspectResult | null>
  updateWorker(options: UpdateWorkerOptions): Promise<WorkerUpdateResult>
  fetchWorkerActivity(options: WorkerActivityOptions): Promise<WorkerActivityResult>

  // Phase 3: Worktree operations
  listWorktrees(options: WorktreeListOptions): Promise<WorktreeListResult>
  createWorktree(options: WorktreeCreateOptions): Promise<WorktreeCreateResult>
  archiveWorktree(options: WorktreeArchiveOptions): Promise<WorktreeArchiveResult>

  // Loop operations
  loopRun(options: LoopRunOptions): Promise<LoopRunResult>
  loopList(): Promise<LoopListResult>
  loopInspect(options: LoopInspectOptions): Promise<LoopInspectResult>
  loopLogs(options: LoopLogsOptions): Promise<LoopLogsResult>
  loopStop(options: LoopStopOptions): Promise<LoopStopResult>

  // Schedule operations
  scheduleList(): Promise<ScheduleListResult>
  scheduleInspect(options: ScheduleInspectOptions): Promise<ScheduleMutationResult>
  scheduleCreate(options: ScheduleCreateOptions): Promise<ScheduleMutationResult>
  scheduleUpdate(options: ScheduleUpdateOptions): Promise<ScheduleMutationResult>
  schedulePause(options: ScheduleInspectOptions): Promise<ScheduleMutationResult>
  scheduleResume(options: ScheduleInspectOptions): Promise<ScheduleMutationResult>
  scheduleDelete(options: ScheduleInspectOptions): Promise<ScheduleDeleteResult>
  scheduleRunOnce(options: ScheduleInspectOptions): Promise<ScheduleMutationResult>
  scheduleLogs(options: ScheduleInspectOptions): Promise<ScheduleLogsResult>
}

/** Error returned by worktree operations. */
export interface WorktreeOperationError {
  code: "NOT_GIT_REPO" | "NOT_ALLOWED" | "MERGE_CONFLICT" | "UNKNOWN"
  message: string
}

/** Single worktree entry returned by list operations. */
export interface WorktreeListEntry {
  worktreePath: string
  createdAt: string
  branchName?: string | null
  head?: string | null
}

/** Result returned by worktree list operations. */
export interface WorktreeListResult {
  requestId: string
  worktrees: WorktreeListEntry[]
  error: WorktreeOperationError | null
}

/** Script or service entry associated with a worktree. */
export interface WorktreeScriptEntry {
  scriptName: string
  type: "script" | "service"
  hostname: string
  port: number | null
  localProxyUrl?: string | null
  publicProxyUrl?: string | null
  proxyUrl: string | null
  lifecycle: "running" | "stopped"
  health: "healthy" | "unhealthy" | null
  exitCode: number | null
  terminalId: string | null
}

/** Aggregate file change counts for a worktree. */
export interface WorktreeDiffStat {
  additions: number
  deletions: number
}

/** Git runtime metadata associated with a worktree. */
export interface WorktreeGitRuntime {
  currentBranch?: string | null
  remoteUrl?: string | null
  isPaseoOwnedWorktree?: boolean
  isDirty?: boolean | null
  aheadBehind?: { ahead: number; behind: number } | null
  aheadOfOrigin?: number | null
  behindOfOrigin?: number | null
}

/** GitHub check summary associated with a worktree. */
export interface WorktreeGithubCheck {
  name: string
  status: "success" | "failure" | "pending" | "skipped" | "cancelled"
  url: string | null
  workflow?: string
  duration?: string
}

/** GitHub pull request summary associated with a worktree. */
export interface WorktreeGithubPullRequest {
  title: string
  url: string
  baseRefName: string
  headRefName: string
  state: string
  isMerged: boolean
  number?: number
  repoOwner?: string
  repoName?: string
  isDraft?: boolean
  mergeable?: "UNKNOWN" | "MERGEABLE" | "CONFLICTING"
  checks?: WorktreeGithubCheck[]
  checksStatus?: "none" | "success" | "failure" | "pending"
  reviewDecision?: "pending" | "approved" | "changes_requested" | null
  github?: unknown
}

/** GitHub runtime metadata associated with a worktree. */
export interface WorktreeGithubRuntime {
  error?: { message: string } | null
  pullRequest?: WorktreeGithubPullRequest | null
  featuresEnabled?: boolean
  refreshedAt?: string | null
}

/** Full worktree workspace record returned by the daemon. */
export interface WorktreeWorkspaceRecord {
  id: string
  projectId: string
  projectDisplayName: string
  projectCustomName?: string | null
  projectRootPath: string
  workspaceDirectory: string
  projectKind: "git" | "non_git" | "directory"
  workspaceKind: "directory" | "local_checkout" | "checkout" | "worktree"
  name: string
  archivingAt: string | null
  status: "needs_input" | "failed" | "running" | "attention" | "done"
  activityAt: string | null
  diffStat?: WorktreeDiffStat | null
  scripts: WorktreeScriptEntry[]
  gitRuntime?: WorktreeGitRuntime | null
  githubRuntime?: WorktreeGithubRuntime | null
}

/** Result returned after creating a worktree. */
export interface WorktreeCreateResult {
  requestId: string
  workspace: WorktreeWorkspaceRecord | null
  error: string | null
}

/** Result returned after archiving a worktree. */
export interface WorktreeArchiveResult {
  requestId: string
  success: boolean
  removedAgents?: string[]
  error: WorktreeOperationError | null
}
