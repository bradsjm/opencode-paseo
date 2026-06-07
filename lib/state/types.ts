// ─── Paseo Domain Types ──────────────────────────────────────────────────────

/** Terminal lifecycle states tracked by the plugin. */
export type TerminalStatus = "running" | "exited" | "killed" | "unknown"

/** Worker lifecycle states tracked by the plugin. */
export type WorkerStatus = "initializing" | "idle" | "running" | "error" | "closed" | "unknown"

/** Inbox event kinds emitted by the Paseo daemon. */
export type InboxEventKind =
  | "worker.stalled"
  | "agent.status"
  | "agent.attention"
  | "chat.mentioned"
  | "permission.requested"
  | "daemon.connected"
  | "daemon.disconnected"

/** A normalized inbox event stored in plugin state. */
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

/** Summary data tracked for a terminal session. */
export interface TerminalSessionSummary {
  id: string
  title: string
  cwd: string
  status: TerminalStatus
  lineCount: number
  lastReadCursor: number
}

/** Summary data tracked for a worker. */
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
  chatRoom?: string
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

/** Session-local bindings and unread state for a connected OpenCode session. */
export interface SessionMapping {
  opencodeSessionId: string
  projectRoot: string
  worktreePath?: string
  createdTerminalIds: Set<string>
  createdWorkerIds: Set<string>
  backgroundWorkerIds: Set<string>
  unreadEvents: Map<string, InboxEvent>
  pendingPermissions: Map<string, InboxEvent>
  createdAt: number
  updatedAt: number
}

/** Record for a worker run that is not managed as a durable launch. */
export interface EphemeralWorkerRunRecord {
  workerId: string
  sessionId: string
  background: boolean
  createdAt: number
}

/** Record for a visible OpenCode task session backed by a Paseo worker. */
export interface TaskRunRecord {
  taskSessionId: string
  parentSessionId: string
  workerId: string
  description: string
  subagentType: string
  background: boolean
  completionInjected?: boolean
  labels?: Record<string, string>
  createdAt: number
}

/** Worker launch lifecycle states tracked by the queue. */
export type WorkerLaunchStatus =
  | "queued"
  | "starting"
  | "created"
  | "failed"
  | "failed_rolled_back"
  | "failed_needs_cleanup"

/** Snapshot entry describing a worktree at launch rollback time. */
export interface WorkerLaunchRollbackSnapshotEntry {
  worktreePath: string
  branchName: string | null
}

/** Candidate worktree that may need cleanup after a failed launch. */
export interface WorkerLaunchRollbackCandidate {
  worktreePath: string
  branchName: string | null
  archiveError?: string
}

/** Metadata describing the outcome of a launch rollback attempt. */
export interface WorkerLaunchRollbackMetadata {
  baselineSnapshot: WorkerLaunchRollbackSnapshotEntry[] | null
  attempted: boolean
  outcome: "not_needed" | "rolled_back" | "needs_cleanup"
  message: string
  suggestedTool?: "paseo_worktree_archive"
  candidateWorktrees?: WorkerLaunchRollbackCandidate[]
}

/** Rollback metadata recorded on launch status updates. */
export type WorkerLaunchStatusRollbackMetadata = Omit<WorkerLaunchRollbackMetadata, "baselineSnapshot">

/** Durable record of a queued or completed worker launch. */
export interface WorkerLaunchRecord {
  launchId: string
  status: WorkerLaunchStatus
  sessionId: string
  projectRoot: string
  profile: string
  cwd: string
  worktreeName: string | null
  chatRoom: string | null
  initialPrompt: string | null
  labels: Record<string, string>
  provider: string
  model?: string
  modeId: string
  enqueuedAt: string
  startedAt: string | null
  finishedAt: string | null
  workerId: string | null
  error: string | null
  rollback: WorkerLaunchRollbackMetadata | null
}

// ─── Plugin State ────────────────────────────────────────────────────────────

/** Snapshot of daemon capabilities discovered during connect. */
export interface CapabilitySnapshot {
  version?: string
  features: string[]
  fetchedAt: number
}

/** Connection lifecycle states for the daemon transport. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

/** Watch state for a worker-attached chat room. */
export interface ChatRoomWatchState {
  name: string
  lastMessageId: string | null
  seededAt: number | null
  watching: boolean
}

/** In-memory plugin state for sessions, workers, terminals, and launches. */
export interface PluginState {
  /** Current connection status to the Paseo daemon */
  connectionStatus: ConnectionStatus

  /** Last error message from connection attempts */
  lastError: string | undefined

  /** Daemon capabilities discovered on connect */
  capabilities: CapabilitySnapshot | null

  /** Session mappings keyed by opencode session ID */
  sessions: Map<string, SessionMapping>

  /** All known terminals keyed by ID */
  terminals: Map<string, TerminalSessionSummary>

  /** All known workers keyed by ID */
  workers: Map<string, WorkerSummary>

  /** Known worker-attached chat rooms keyed by room name */
  chatRooms: Map<string, ChatRoomWatchState>

  /** Global inbox events (across sessions), keyed by event ID */
  inbox: Map<string, InboxEvent>

  /** Known worker launch requests keyed by launch ID */
  workerLaunches: Map<string, WorkerLaunchRecord>

  /** Ephemeral non-detached worker runs keyed by worker ID */
  ephemeralWorkerRuns: Map<string, EphemeralWorkerRunRecord>

  /** Paseo-backed task runs keyed by visible OpenCode child task session ID */
  taskRuns: Map<string, TaskRunRecord>

  /** Worker IDs currently watched for task completion injection */
  taskCompletionWatchers: Set<string>

  /** FIFO queue of pending worker launch IDs */
  workerLaunchQueue: string[]

  /** Currently active worker launch ID, if any */
  activeWorkerLaunchId: string | null

  /** Monotonic event counter for cursor-based pagination */
  eventCounter: number
}
