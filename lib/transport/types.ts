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
}
