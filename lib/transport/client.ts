import type { DaemonConfig } from "../config.js"
import type {
    HelloMessage,
    SessionRequest,
    AgentSummary,
    AgentEntry,
    FetchAgentsRequest,
    GetProvidersSnapshotRequest,
    ListTerminalsRequest,
    TerminalSummary,
    DaemonEvent,
    DaemonEventCallback,
    ServerInfo,
    PongMessage,
} from "./types.js"

// ─── Paseo Daemon Client ────────────────────────────────────────────────────
// Speaks the real Paseo daemon WebSocket protocol:
//   - Endpoint: ws://host:port/ws
//   - Hello handshake on connect → server_info confirmation
//   - Session-wrapped messages with requestId correlation
//   - Ping/pong keepalive
//   - Auth via Sec-WebSocket-Protocol or Authorization header

export class PaseoClient {
    private config: DaemonConfig
    private ws: WebSocket | null = null
    private eventListeners: DaemonEventCallback[] = []
    private connected = false
    private serverInfo: ServerInfo | null = null
    private pendingRequests = new Map<
        string,
        {
            resolve: (value: unknown) => void
            reject: (reason: Error) => void
            timer: ReturnType<typeof setTimeout>
        }
    >()
    private static readonly APP_VERSION = "0.1.89"

    constructor(config: DaemonConfig) {
        this.config = config
    }

    private get url(): string {
        const host = this.config.host.includes(":") ? `[${this.config.host}]` : this.config.host
        return `ws://${host}:${this.config.port}/ws`
    }

    // ─── Connection ──────────────────────────────────────────────────────

    async connect(): Promise<ServerInfo> {
        if (this.connected && this.serverInfo) return this.serverInfo

        return new Promise<ServerInfo>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.cleanupSocket()
                reject(new Error(`Connection timeout after ${this.config.connectionTimeoutMs}ms`))
            }, this.config.connectionTimeoutMs)

            try {
                const headers: Record<string, string> = {}
                const protocols: string[] = []
                if (this.config.password) {
                    headers["Authorization"] = `Bearer ${this.config.password}`
                    protocols.push(`paseo.bearer.${this.config.password}`)
                }

                const ws = new (WebSocket as any)(
                    this.url,
                    protocols.length > 0 ? protocols : undefined,
                    { headers },
                )
                this.ws = ws

                ws.onopen = () => {
                    this.sendHello()
                }

                ws.onerror = (err: any) => {
                    clearTimeout(timeout)
                    reject(new Error(`WebSocket error: ${err.message || err}`))
                }

                ws.onclose = () => {
                    const wasConnected = this.connected
                    this.connected = false
                    this.serverInfo = null
                    this.rejectAllPending("Connection closed")
                    if (wasConnected) {
                        this.notifyEvent({ type: "daemon.disconnected", payload: {} })
                    }
                }

                ws.onmessage = (msg: MessageEvent) => {
                    this.handleMessage(msg, (info: ServerInfo) => {
                        clearTimeout(timeout)
                        this.connected = true
                        this.serverInfo = info
                        resolve(info)
                    })
                }
            } catch (err: any) {
                clearTimeout(timeout)
                reject(err)
            }
        })
    }

    disconnect(): void {
        this.cleanupSocket()
        this.connected = false
        this.serverInfo = null
        this.rejectAllPending("Disconnected")
    }

    isConnected(): boolean {
        return this.connected
    }

    getServerInfo(): ServerInfo | null {
        return this.serverInfo
    }

    // ─── Hello Handshake ─────────────────────────────────────────────────

    private sendHello(): void {
        const hello: HelloMessage = {
            type: "hello",
            clientId: `opencode-paseo-${crypto.randomUUID()}`,
            clientType: "cli",
            protocolVersion: 1,
            appVersion: PaseoClient.APP_VERSION,
            capabilities: {
                streaming: false,
                terminalOutput: false,
            },
        }
        this.ws!.send(JSON.stringify(hello))
    }

    // ─── Data Fetching ───────────────────────────────────────────────────

    async fetchAgents(
        options?: Pick<FetchAgentsRequest, "scope" | "subscribe">,
    ): Promise<AgentSummary[]> {
        const response = await this.sendRequest<{ entries: AgentEntry[] }>({
            type: "fetch_agents_request",
            ...(options?.scope ? { scope: options.scope } : {}),
            ...(options?.subscribe ? { subscribe: options.subscribe } : {}),
        })
        return (response.entries ?? []).map((entry) => entry.agent)
    }

    async listTerminals(cwd?: string): Promise<TerminalSummary[]> {
        const response = await this.sendRequest<{ terminals: TerminalSummary[] }>({
            type: "list_terminals_request",
            ...(cwd ? { cwd } : {}),
        })
        return response.terminals ?? []
    }

    async getStatus(): Promise<Record<string, unknown>> {
        return this.sendRequest<Record<string, unknown>>({ type: "daemon.get_status.request" })
    }

    async getProvidersSnapshot(cwd?: string): Promise<Array<Record<string, unknown>>> {
        const response = await this.sendRequest<{ entries: Array<Record<string, unknown>> }>({
            type: "get_providers_snapshot_request",
            ...(cwd ? { cwd } : {}),
        })
        return response.entries ?? []
    }

    // ─── Event Subscription ──────────────────────────────────────────────

    onEvent(callback: DaemonEventCallback): () => void {
        this.eventListeners.push(callback)
        return () => {
            this.eventListeners = this.eventListeners.filter((l) => l !== callback)
        }
    }

    // ─── Internal: Request/Response ──────────────────────────────────────

    private async sendRequest<T>(
        message:
            | Omit<FetchAgentsRequest, "requestId">
            | Omit<ListTerminalsRequest, "requestId">
            | Omit<GetProvidersSnapshotRequest, "requestId">
            | { type: "daemon.get_status.request" },
    ): Promise<T> {
        if (!this.ws || !this.connected) {
            throw new Error("Not connected to Paseo daemon")
        }

        const requestId = crypto.randomUUID()
        const request: SessionRequest = {
            type: "session",
            message: {
                requestId,
                ...message,
            } as any,
        }

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId)
                reject(new Error(`Request timeout: ${message.type}`))
            }, this.config.connectionTimeoutMs)

            this.pendingRequests.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
            })

            this.ws!.send(JSON.stringify(request))
        })
    }

    // ─── Internal: Message Handling ──────────────────────────────────────

    private handleMessage(msg: MessageEvent, onConnected?: (info: ServerInfo) => void): void {
        let data: any
        try {
            data = JSON.parse(String(msg.data))
        } catch {
            return
        }

        // Handle pong responses
        if (data.type === "pong") {
            return
        }

        // Handle ping from server — respond with pong
        if (data.type === "ping") {
            const pong: PongMessage = { type: "pong" }
            try {
                this.ws?.send(JSON.stringify(pong))
            } catch {
                // Ignore send errors during ping response
            }
            return
        }

        // Handle session_message or session (responses and events)
        if ((data.type === "session_message" || data.type === "session") && data.message) {
            const message = data.message

            // Server info status — handshake confirmation
            if (message.type === "status" && message.payload?.status === "server_info") {
                const info: ServerInfo = {
                    serverId: message.payload.serverId,
                    hostname: message.payload.hostname,
                    version: message.payload.version,
                    features: message.payload.features ?? {},
                    capabilities: message.payload.capabilities ?? {},
                }
                if (onConnected) {
                    onConnected(info)
                }
                return
            }

            // RPC error response — reject the pending promise
            if (message.type === "rpc_error" && message.payload?.requestId) {
                const pending = this.pendingRequests.get(message.payload.requestId)
                if (pending) {
                    clearTimeout(pending.timer)
                    this.pendingRequests.delete(message.payload.requestId)
                    const errMsg = (message.payload.error as string) ?? "Unknown RPC error"
                    const errCode = message.payload.code as string | undefined
                    pending.reject(new Error(errCode ? `${errMsg} (code: ${errCode})` : errMsg))
                    return
                }
            }

            // Response to a pending request
            if (message.payload?.requestId) {
                const pending = this.pendingRequests.get(message.payload.requestId)
                if (pending) {
                    clearTimeout(pending.timer)
                    this.pendingRequests.delete(message.payload.requestId)
                    pending.resolve(message.payload)
                    return
                }
            }

            // Server-pushed event (agent lifecycle, etc.)
            if (message.type && message.payload) {
                const translated = this.translateDaemonEvent(message.type, message.payload)
                if (translated) {
                    this.notifyEvent(translated)
                }
            }
            return
        }

        // Fallback: any other message with a type is treated as an event
        if (data.type) {
            this.notifyEvent({ type: data.type, payload: data.payload ?? data })
        }
    }

    // ─── Internal: Event Translation ─────────────────────────────────────

    private translateDaemonEvent(
        type: string,
        payload: Record<string, unknown>,
    ): DaemonEvent | null {
        switch (type) {
            case "agent_update": {
                // Real shape: { kind: "upsert", agent: { id, status, requiresAttention, ... } }
                if (payload.kind === "remove" && typeof payload.agentId === "string") {
                    return {
                        type: "worker.finished",
                        payload: { ...payload, workerId: payload.agentId },
                    }
                }
                const agent = payload.agent as Record<string, unknown> | undefined
                if (!agent) {
                    return { type, payload }
                }
                const agentId = agent.id as string
                const status = agent.status as string
                const requiresAttention = agent.requiresAttention as boolean | undefined
                const attentionReason = agent.attentionReason as string | undefined
                const pendingPermissions = agent.pendingPermissions

                if (
                    requiresAttention &&
                    (attentionReason === "permission" ||
                        (Array.isArray(pendingPermissions) && pendingPermissions.length > 0))
                ) {
                    return {
                        type: "worker.blocked",
                        payload: {
                            ...payload,
                            workerId: agentId,
                            summary: agent.attentionReason as string,
                        },
                    }
                }
                if (status === "error") {
                    return { type: "worker.failed", payload: { ...payload, workerId: agentId } }
                }
                if (status === "closed") {
                    return { type: "worker.finished", payload: { ...payload, workerId: agentId } }
                }
                // running, idle, initializing
                return { type: "worker.started", payload: { ...payload, workerId: agentId } }
            }
            case "agent_permission_request": {
                // Real shape: { request: { id, ... }, agentId, ... }
                const request = payload.request as Record<string, unknown> | undefined
                const permissionId = request?.id as string | undefined
                const agentId = payload.agentId as string
                return {
                    type: "permission.requested",
                    payload: { ...payload, workerId: agentId, permissionId },
                }
            }
            case "agent_permission_resolved": {
                // Real shape: { requestId, agentId, resolution, ... }
                const permissionId = payload.requestId as string | undefined
                const agentId = payload.agentId as string
                return {
                    type: "permission.resolved",
                    payload: { ...payload, workerId: agentId, permissionId },
                }
            }
            case "agent_deleted":
                return {
                    type: "worker.finished",
                    payload: { ...payload, workerId: payload.agentId },
                }
            case "agent_stream":
                // Streaming output — too noisy for inbox, skip
                return null
            default:
                // Unknown event — forward as-is
                return { type, payload }
        }
    }

    // ─── Internal: Cleanup ───────────────────────────────────────────────

    private cleanupSocket(): void {
        if (this.ws) {
            this.ws.onopen = null
            this.ws.onerror = null
            this.ws.onclose = null
            this.ws.onmessage = null
            this.ws.close()
            this.ws = null
        }
    }

    private rejectAllPending(reason: string): void {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error(reason))
        }
        this.pendingRequests.clear()
    }

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
