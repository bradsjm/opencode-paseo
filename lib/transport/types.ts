// ─── Paseo Daemon Wire Protocol Types ────────────────────────────────────────
// Based on the real Paseo daemon protocol discovered from source code.
// WebSocket endpoint: ws://host:port/ws
// Auth: Sec-WebSocket-Protocol: paseo.bearer.<password> or Authorization header

// ─── Hello Handshake ─────────────────────────────────────────────────────────

export interface HelloMessage {
    type: "hello"
    clientId: string
    clientType: "cli" | "web"
    protocolVersion: 1
    appVersion?: string
    capabilities: {
        streaming?: boolean
        terminalOutput?: boolean
    }
}

// ─── Server Info (sent after hello) ──────────────────────────────────────────

export interface ServerInfo {
    serverId: string
    hostname?: string
    version?: string
    features: Record<string, boolean>
    capabilities: Record<string, unknown>
}

export interface StatusPayload {
    status: "server_info"
    serverId: string
    hostname?: string
    version?: string
    features: Record<string, boolean>
    capabilities: Record<string, unknown>
}

// ─── Session Message Wrappers ────────────────────────────────────────────────

export interface SessionRequest {
    type: "session"
    message: SessionMessage
}

export interface SessionResponse {
    type: "session_message"
    message: SessionMessage
}

export type SessionMessage =
    | FetchAgentsRequest
    | FetchAgentsResponse
    | ListTerminalsRequest
    | ListTerminalsResponse
    | GetProvidersSnapshotRequest
    | GetProvidersSnapshotResponse
    | DaemonGetStatusRequest
    | DaemonGetStatusResponse
    | StatusMessage

// ─── Status Message (server_info confirmation) ───────────────────────────────

export interface StatusMessage {
    type: "status"
    payload: StatusPayload
}

// ─── Request/Response Pairs ──────────────────────────────────────────────────

export interface FetchAgentsRequest {
    type: "fetch_agents_request"
    requestId: string
    scope?: "active"
    subscribe?: {
        subscriptionId?: string
    }
}

export interface AgentSummary {
    id: string
    provider?: string
    cwd?: string
    model?: string
    status: string
    title?: string
    labels?: Record<string, unknown> | string[]
    worktreePath?: string
    branchName?: string
    capabilities?: Record<string, unknown>
    runtimeInfo?: Record<string, unknown>
    requiresAttention?: boolean
    attentionReason?: string | null
    attentionTimestamp?: string | null
    pendingPermissions?: Array<Record<string, unknown>>
    createdAt?: string
    updatedAt?: string
    [key: string]: unknown
}

export interface AgentEntry {
    agent: AgentSummary
}

export interface FetchAgentsResponse {
    type: "fetch_agents_response"
    payload: {
        requestId: string
        subscriptionId?: string
        entries: AgentEntry[]
        pageInfo?: Record<string, unknown>
    }
}

export interface ListTerminalsRequest {
    type: "list_terminals_request"
    requestId: string
    cwd?: string
}

export interface TerminalSummary {
    id: string
    title?: string
    cwd?: string
    status?: string
    lineCount?: number
    [key: string]: unknown
}

export interface ListTerminalsResponse {
    type: "list_terminals_response"
    payload: {
        requestId: string
        terminals: TerminalSummary[]
    }
}

export interface GetProvidersSnapshotRequest {
    type: "get_providers_snapshot_request"
    requestId: string
    cwd?: string
}

export interface GetProvidersSnapshotResponse {
    type: "get_providers_snapshot_response"
    payload: {
        requestId: string
        entries: Array<Record<string, unknown>>
    }
}

export interface DaemonGetStatusRequest {
    type: "daemon.get_status.request"
    requestId: string
}

export interface DaemonGetStatusResponse {
    type: "daemon.get_status.response"
    payload: {
        requestId: string
        status: string
        version: string
        uptime: number
        [key: string]: unknown
    }
}

// ─── RPC Error ────────────────────────────────────────────────────────────────

export interface RpcErrorPayload {
    requestId: string
    requestType?: string
    error: string
    code?: string
}

// ─── Ping/Pong ───────────────────────────────────────────────────────────────

export interface PingMessage {
    type: "ping"
    requestId: string
}

export interface PongMessage {
    type: "pong"
}

// ─── Agent Lifecycle Events (server-pushed) ──────────────────────────────────

export interface AgentUpdateEvent {
    type: "session_message"
    message: {
        type: "agent_update"
        payload: {
            agentId: string
            status: string
            title?: string
            [key: string]: unknown
        }
    }
}

export interface AgentStreamEvent {
    type: "session_message"
    message: {
        type: "agent_stream"
        payload: {
            agentId: string
            chunk: string
            [key: string]: unknown
        }
    }
}

export interface AgentPermissionRequestEvent {
    type: "session_message"
    message: {
        type: "agent_permission_request"
        payload: {
            permissionId: string
            agentId: string
            kind: string
            summary: string
            [key: string]: unknown
        }
    }
}

export interface AgentPermissionResolvedEvent {
    type: "session_message"
    message: {
        type: "agent_permission_resolved"
        payload: {
            permissionId: string
            agentId: string
            resolution: string
            [key: string]: unknown
        }
    }
}

export interface AgentDeletedEvent {
    type: "session_message"
    message: {
        type: "agent_deleted"
        payload: {
            agentId: string
            [key: string]: unknown
        }
    }
}

// ─── Generic Daemon Event (for plugin consumers) ─────────────────────────────

export interface DaemonEvent {
    type: string
    payload: Record<string, unknown>
}

export type DaemonEventCallback = (event: DaemonEvent) => void
