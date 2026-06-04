// ─── Plugin-Owned Transport Types ─────────────────────────────────────────────
// These types represent the plugin's view of the daemon, not the wire protocol.
// The adapter in client.ts maps upstream @getpaseo/client types into these shapes.

// ─── Server Info ──────────────────────────────────────────────────────────────

export interface ServerInfo {
    serverId: string
    hostname?: string
    version?: string
    features: Record<string, boolean>
    capabilities: Record<string, unknown>
}

// ─── Agent Summary ────────────────────────────────────────────────────────────
// Mapped from upstream AgentSnapshotPayload.

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

export interface TerminalSummary {
    id: string
    name: string
    title?: string
}

// ─── Phase 3 Worker Types ─────────────────────────────────────────────────────
// Plugin-level shapes for worker (agent) mutation and inspection.

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

export interface RunWorkerOptions extends CreateWorkerOptions {
    background?: boolean
}

export interface CreatedWorker {
    id: string
    provider: string
    cwd: string
    model: string | null
    status: string
    title: string | null
}

export interface WorkerWaitResult {
    status: "idle" | "error" | "permission" | "timeout"
    workerId: string
    error: string | null
    lastMessage: string | null
    finalSnapshot: AgentSummary | null
}

export interface WorkerWaitNudgeEvent {
    kind:
        | "worker.stalled"
        | "worker.finished"
        | "worker.failed"
        | "worker.blocked"
        | "chat.mentioned"
        | "permission.requested"
    workerId: string
    summary: string
}

export interface ChatRoomSummary {
    id: string
    name: string
    purpose: string | null
    createdAt: string
    updatedAt: string
    messageCount: number
    lastMessageAt: string | null
}

export interface ChatMessage {
    id: string
    roomId: string
    authorAgentId: string
    body: string
    replyToMessageId: string | null
    mentionAgentIds: string[]
    createdAt: string
}

export interface CreateChatRoomOptions {
    name: string
    purpose?: string | null
}

export interface InspectChatRoomOptions {
    room: string
}

export interface DeleteChatRoomOptions {
    room: string
}

export interface PostChatMessageOptions {
    room: string
    body: string
    authorAgentId?: string
    replyToMessageId?: string | null
}

export interface ReadChatMessagesOptions {
    room: string
    limit?: number
    since?: string
    authorAgentId?: string
}

export interface WaitForChatMessagesOptions {
    room: string
    afterMessageId?: string | null
    timeoutMs?: number
}

export interface ChatRoomMutationResult {
    requestId: string
    room: ChatRoomSummary | null
    error: string | null
}

export interface ChatRoomListResult {
    requestId: string
    rooms: ChatRoomSummary[]
    error: string | null
}

export interface ChatMessageMutationResult {
    requestId: string
    message: ChatMessage | null
    error: string | null
}

export interface ChatReadResult {
    requestId: string
    messages: ChatMessage[]
    error: string | null
}

export interface ChatWaitResult {
    requestId: string
    messages: ChatMessage[]
    timedOut: boolean
    error: string | null
}

export interface MultiWorkerWaitResult {
    waitFor: "any" | "all"
    workerIds: string[]
    results: WorkerWaitResult[]
    pendingWorkerIds: string[]
    interruptedByNudge: boolean
    nudgeEvent?: WorkerWaitNudgeEvent
    timedOut: boolean
}

export interface ArchivedWorker {
    workerId: string
    archivedAt: string
}

export interface WorkerInspectResult {
    agent: AgentSummary
    project: Record<string, unknown> | null
}

// ─── Phase 3 Worktree Types ───────────────────────────────────────────────────

export interface WorktreeListOptions {
    cwd?: string
    repoRoot?: string
}

export interface WorktreeCreateOptions {
    cwd: string
    projectId?: string
    worktreeSlug?: string
    refName?: string
    action?: string
    githubPrNumber?: number
    firstAgentContext?: Record<string, unknown>
}

export interface WorktreeArchiveOptions {
    worktreePath?: string
    repoRoot?: string
    branchName?: string
}

// ─── Phase 2 Result Types ─────────────────────────────────────────────────────
// Plugin-level shapes returned by terminal and permission operations.

export interface CreatedTerminal {
    id: string
    name: string
    title?: string
    cwd?: string
}

export interface TerminalCapture {
    terminalId: string
    content: string
    lineCount: number
    truncated: boolean
}

export interface KilledTerminal {
    id: string
    exitCode?: number | null
}

export interface PermissionResponse {
    workerId: string
    permissionId: string
    behavior: "allow" | "deny"
}

export interface CreateTerminalOptions {
    cwd: string
    name?: string
    agentId?: string
    command?: string
    args?: string[]
}

export interface CaptureTerminalOptions {
    terminalId: string
    start?: number
    end?: number
    stripAnsi?: boolean
}

export interface RespondPermissionOptions {
    workerId: string
    permissionId: string
    behavior: "allow" | "deny"
    message?: string
    interrupt?: boolean
    selectedActionId?: string
}

// ─── Schedule Types ───────────────────────────────────────────────────────────
// Plugin-level shapes for schedule operations (thin wrappers over daemon RPCs).

export type ScheduleCadence =
    | { type: "every"; everyMs: number }
    | { type: "cron"; expression: string; timezone?: string }

export interface ScheduleNewAgentConfig {
    provider: string
    cwd: string
    modeId?: string
    model?: string
}

export interface ScheduleTargetSelf {
    type: "self"
    agentId: string
}

export interface ScheduleTargetAgent {
    type: "agent"
    agentId: string
}

export interface ScheduleTargetNewAgent {
    type: "new-agent"
    config: ScheduleNewAgentConfig
}

export type ScheduleTarget = ScheduleTargetSelf | ScheduleTargetAgent | ScheduleTargetNewAgent

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

export interface ScheduleMutationResult {
    requestId: string
    schedule: ScheduleRecord | null
    error: string | null
}

export interface ScheduleListResult {
    requestId: string
    schedules: ScheduleRecord[]
    error: string | null
}

export interface ScheduleDeleteResult {
    requestId: string
    scheduleId: string
    error: string | null
}

export interface ScheduleLogsResult {
    requestId: string
    runs: ScheduleRunRecord[]
    error: string | null
}

export interface ScheduleCreateOptions {
    prompt: string
    name?: string
    cadence: ScheduleCadence
    target: ScheduleTarget
    maxRuns?: number
    expiresAt?: string
    runOnCreate?: boolean
}

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

export interface ScheduleInspectOptions {
    id: string
}

// ─── Worker Update Types ──────────────────────────────────────────────────────

export interface WorkerUpdateSettings {
    modeId?: string
    model?: string | null
    thinkingOptionId?: string | null
    features?: Record<string, unknown>
}

export interface UpdateWorkerOptions {
    workerId: string
    name?: string
    labels?: Record<string, string>
    settings?: WorkerUpdateSettings
}

export interface WorkerUpdateResult {
    workerId: string
    updated: boolean
    metadataUpdated: boolean
    settingsUpdated: boolean
    errors: string[]
}

// ─── Worker Activity Types ────────────────────────────────────────────────────

export interface WorkerActivityOptions {
    workerId: string
    limit?: number
}

export interface WorkerActivityEntrySummary {
    kind: string
    timestamp?: string
    toolName?: string
    status?: string
    summary: string
}

export interface WorkerActivitySummary {
    entries: WorkerActivityEntrySummary[]
    hasMore: boolean
}

export interface WorkerActivityResult {
    workerId: string
    activity: WorkerActivitySummary | null
}

// ─── Normalized Daemon Event ──────────────────────────────────────────────────
// The adapter translates upstream DaemonClient events into this shape
// before delivering them to plugin consumers.

export interface WorkerEventPayload extends Record<string, unknown> {
    workerId: string
    summary?: string
}

export interface WorkerActivityPayload extends Record<string, unknown> {
    workerId: string
    timestamp?: string
    subtype?: string
    summary?: string
}

export interface PermissionRequestedPayload extends Record<string, unknown> {
    workerId: string
    permissionId?: string
    request: Record<string, unknown>
}

export interface PermissionResolvedPayload extends Record<string, unknown> {
    workerId: string
    permissionId: string
    resolution: Record<string, unknown>
}

export interface DaemonConnectedEvent {
    type: "daemon.connected"
    payload: {}
}

export interface DaemonDisconnectedEvent {
    type: "daemon.disconnected"
    payload: {}
}

export interface DaemonErrorEvent {
    type: "daemon.error"
    payload: { message: string }
}

export interface WorkerStartedEvent {
    type: "worker.started"
    payload: WorkerEventPayload
}

export interface WorkerStalledEvent {
    type: "worker.stalled"
    payload: WorkerEventPayload
}

export interface WorkerActivityEvent {
    type: "worker.activity"
    payload: WorkerActivityPayload
}

export interface WorkerFinishedEvent {
    type: "worker.finished"
    payload: WorkerEventPayload
}

export interface WorkerFailedEvent {
    type: "worker.failed"
    payload: WorkerEventPayload
}

export interface WorkerBlockedEvent {
    type: "worker.blocked"
    payload: WorkerEventPayload
}

export interface PermissionRequestedEvent {
    type: "permission.requested"
    payload: PermissionRequestedPayload
}

export interface PermissionResolvedEvent {
    type: "permission.resolved"
    payload: PermissionResolvedPayload
}

export type DaemonEvent =
    | DaemonConnectedEvent
    | DaemonDisconnectedEvent
    | DaemonErrorEvent
    | WorkerStartedEvent
    | WorkerStalledEvent
    | WorkerActivityEvent
    | WorkerFinishedEvent
    | WorkerFailedEvent
    | WorkerBlockedEvent
    | PermissionRequestedEvent
    | PermissionResolvedEvent

export type DaemonEventCallback = (event: DaemonEvent) => void

// ─── Fetch Agents Options ─────────────────────────────────────────────────────

export interface FetchAgentsOptions {
    subscribe?: { subscriptionId: string }
}

// ─── Transport Contract ───────────────────────────────────────────────────────
// The minimal interface the plugin needs from a Paseo daemon connection.

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

export interface WorktreeOperationError {
    code: "NOT_GIT_REPO" | "NOT_ALLOWED" | "MERGE_CONFLICT" | "UNKNOWN"
    message: string
}

export interface WorktreeListEntry {
    worktreePath: string
    createdAt: string
    branchName?: string | null
    head?: string | null
}

export interface WorktreeListResult {
    requestId: string
    worktrees: WorktreeListEntry[]
    error: WorktreeOperationError | null
}

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

export interface WorktreeDiffStat {
    additions: number
    deletions: number
}

export interface WorktreeGitRuntime {
    currentBranch?: string | null
    remoteUrl?: string | null
    isPaseoOwnedWorktree?: boolean
    isDirty?: boolean | null
    aheadBehind?: { ahead: number; behind: number } | null
    aheadOfOrigin?: number | null
    behindOfOrigin?: number | null
}

export interface WorktreeGithubCheck {
    name: string
    status: "success" | "failure" | "pending" | "skipped" | "cancelled"
    url: string | null
    workflow?: string
    duration?: string
}

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

export interface WorktreeGithubRuntime {
    error?: { message: string } | null
    pullRequest?: WorktreeGithubPullRequest | null
    featuresEnabled?: boolean
    refreshedAt?: string | null
}

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

export interface WorktreeCreateResult {
    requestId: string
    workspace: WorktreeWorkspaceRecord | null
    error: string | null
}

export interface WorktreeArchiveResult {
    requestId: string
    success: boolean
    removedAgents?: string[]
    error: WorktreeOperationError | null
}
