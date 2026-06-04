// ─── Paseo Domain Types ──────────────────────────────────────────────────────

export type TerminalStatus = "running" | "exited" | "killed" | "unknown"

export type WorkerStatus =
    | "running"
    | "idle"
    | "blocked"
    | "failed"
    | "finished"
    | "canceled"
    | "unknown"

export type InboxEventKind =
    | "worker.started"
    | "worker.finished"
    | "worker.failed"
    | "worker.blocked"
    | "permission.requested"
    | "permission.resolved"
    | "daemon.connected"
    | "daemon.disconnected"

export interface InboxEvent {
    id: string
    kind: InboxEventKind
    resourceId: string
    blocking: boolean
    summary: string
    read: boolean
    timestamp: number
    metadata?: Record<string, unknown>
}

export interface TerminalSessionSummary {
    id: string
    title: string
    cwd: string
    status: TerminalStatus
    lineCount: number
    lastReadCursor: number
}

export interface WorkerSummary {
    id: string
    title: string
    agent: string
    status: WorkerStatus
    rawStatus?: string
    cwd: string
    provider: string
    model: string | null
    currentModeId: string | null
    labels: string[]
    worktreePath?: string
    branchName?: string
    pendingPermissions: Array<Record<string, unknown>>
    pendingPermissionIds: string[]
    requiresAttention: boolean
    attentionReason: string | null
    runtimeInfo: Record<string, unknown> | null
    persistence: Record<string, unknown> | null
    unreadEventCount: number
    createdAt?: string
    updatedAt?: string
}

export interface SessionMapping {
    opencodeSessionId: string
    projectRoot: string
    worktreePath?: string
    createdTerminalIds: Set<string>
    createdWorkerIds: Set<string>
    unreadEvents: Map<string, InboxEvent>
    pendingPermissions: Map<string, InboxEvent>
    createdAt: number
    updatedAt: number
}

// ─── Plugin State ────────────────────────────────────────────────────────────

export interface CapabilitySnapshot {
    version?: string
    features: string[]
    fetchedAt: number
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

export interface PluginState {
    /** Current connection status to the Paseo daemon */
    connectionStatus: ConnectionStatus

    /** Last error message from connection attempts */
    lastError?: string

    /** Daemon capabilities discovered on connect */
    capabilities: CapabilitySnapshot | null

    /** Session mappings keyed by opencode session ID */
    sessions: Map<string, SessionMapping>

    /** All known terminals keyed by ID */
    terminals: Map<string, TerminalSessionSummary>

    /** All known workers keyed by ID */
    workers: Map<string, WorkerSummary>

    /** Global inbox events (across sessions), keyed by event ID */
    inbox: Map<string, InboxEvent>

    /** Monotonic event counter for cursor-based pagination */
    eventCounter: number
}
