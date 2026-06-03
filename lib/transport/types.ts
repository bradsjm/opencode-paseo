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

export interface ScheduleCreateOptions {
    prompt: string
    name?: string
    cadence: ScheduleCadence
    target:
        | { type: "self"; agentId: string }
        | { type: "agent"; agentId: string }
        | { type: "new-agent"; config: ScheduleNewAgentConfig }
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

export interface WorkerActivityResult {
    workerId: string
    timeline: Record<string, unknown> | null
}

// ─── Normalized Daemon Event ──────────────────────────────────────────────────
// The adapter translates upstream DaemonClient events into this shape
// before delivering them to plugin consumers.

export interface DaemonEvent {
    type: string
    payload: Record<string, unknown>
}

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
    sendTerminalInput(terminalId: string, input: string): Promise<void>
    killTerminal(terminalId: string): Promise<KilledTerminal>

    // Phase 2: Permission operations
    respondToPermission(options: RespondPermissionOptions): Promise<PermissionResponse>

    // Phase 3: Worker operations
    createWorker(options: CreateWorkerOptions): Promise<CreatedWorker>
    sendWorkerMessage(workerId: string, message: string): Promise<void>
    waitForWorker(workerId: string, timeout: number): Promise<WorkerWaitResult>
    cancelWorker(workerId: string): Promise<void>
    killWorker(workerId: string): Promise<void>
    archiveWorker(workerId: string): Promise<ArchivedWorker>
    fetchWorker(workerId: string): Promise<WorkerInspectResult | null>
    updateWorker(options: UpdateWorkerOptions): Promise<WorkerUpdateResult>
    fetchWorkerActivity(options: WorkerActivityOptions): Promise<WorkerActivityResult>

    // Phase 3: Worktree operations
    listWorktrees(options: WorktreeListOptions): Promise<Record<string, unknown>>
    createWorktree(options: WorktreeCreateOptions): Promise<Record<string, unknown>>
    archiveWorktree(options: WorktreeArchiveOptions): Promise<Record<string, unknown>>

    // Schedule operations
    scheduleList(): Promise<Record<string, unknown>>
    scheduleInspect(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
    scheduleCreate(options: ScheduleCreateOptions): Promise<Record<string, unknown>>
    scheduleUpdate(options: ScheduleUpdateOptions): Promise<Record<string, unknown>>
    schedulePause(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
    scheduleResume(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
    scheduleDelete(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
    scheduleRunOnce(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
    scheduleLogs(options: ScheduleInspectOptions): Promise<Record<string, unknown>>
}
