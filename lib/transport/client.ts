import { DaemonClient } from "@getpaseo/client"
import type {
    DaemonClientConfig,
    DaemonEvent as UpstreamDaemonEvent,
    ConnectionState,
} from "@getpaseo/client"
import type { DaemonConfig } from "../config.js"
import type {
    AgentSummary,
    FetchAgentsOptions,
    TerminalSummary,
    ServerInfo,
    DaemonEvent,
    DaemonEventCallback,
    PaseoTransport,
} from "./types.js"

// ─── Paseo Client Adapter ─────────────────────────────────────────────────────
// Wraps @getpaseo/client DaemonClient and exposes the PaseoTransport interface
// that the rest of the plugin depends on. Translates upstream typed events into
// the normalized DaemonEvent shape used by the inbox and state layer.

const APP_VERSION = "0.1.89"

// ─── Exported Pure Functions (for testing) ────────────────────────────────────

export function buildDaemonConfig(config: DaemonConfig): DaemonClientConfig {
    const host = config.host.includes(":") ? `[${config.host}]` : config.host
    return {
        url: `ws://${host}:${config.port}/ws`,
        clientId: `opencode-paseo-${crypto.randomUUID()}`,
        clientType: "cli",
        appVersion: APP_VERSION,
        password: config.password,
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
        hostname: info.hostname ?? undefined,
        version: info.version ?? undefined,
        features: (info.features ?? {}) as Record<string, boolean>,
        capabilities: (info.capabilities ?? {}) as Record<string, unknown>,
    }
}

export function mapAgentSnapshot(agent: Record<string, unknown>): AgentSummary {
    const labels = (agent.labels ?? {}) as Record<string, string>
    return {
        id: agent.id as string,
        provider: (agent.provider as string) ?? "unknown",
        cwd: (agent.cwd as string) ?? "",
        model: (agent.model as string | null) ?? null,
        status: (agent.status as string) ?? "unknown",
        title: (agent.title as string | null) ?? null,
        labels,
        requiresAttention: agent.requiresAttention as boolean | undefined,
        attentionReason: (agent.attentionReason as string | null) ?? null,
        attentionTimestamp: (agent.attentionTimestamp as string | null) ?? null,
        pendingPermissions: (agent.pendingPermissions as Array<Record<string, unknown>>) ?? [],
        capabilities: (agent.capabilities as Record<string, unknown>) ?? {},
        runtimeInfo: (agent.runtimeInfo as Record<string, unknown>) ?? undefined,
        createdAt: agent.createdAt as string | undefined,
        updatedAt: agent.updatedAt as string | undefined,
        worktreePath:
            (agent.worktreePath as string | undefined) ?? labels.worktreePath ?? undefined,
        branchName: (agent.branchName as string | undefined) ?? labels.branchName ?? undefined,
    }
}

export function translateUpstreamEvent(event: UpstreamDaemonEvent): DaemonEvent | null {
    switch (event.type) {
        case "agent_update": {
            const payload = event.payload as Record<string, unknown>
            const kind = payload.kind as string | undefined

            if (kind === "remove") {
                return {
                    type: "worker.finished",
                    payload: { ...payload, workerId: event.agentId },
                }
            }

            const agent = payload.agent as Record<string, unknown> | undefined
            if (!agent) {
                return {
                    type: "agent_update",
                    payload: { ...payload, workerId: event.agentId },
                }
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
                        summary: attentionReason,
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

        case "agent_deleted":
            return {
                type: "worker.finished",
                payload: { workerId: event.agentId },
            }

        case "agent_permission_request":
            return {
                type: "permission.requested",
                payload: {
                    workerId: event.agentId,
                    permissionId: event.request?.id,
                    request: event.request as unknown as Record<string, unknown>,
                },
            }

        case "agent_permission_resolved":
            return {
                type: "permission.resolved",
                payload: {
                    workerId: event.agentId,
                    permissionId: event.requestId,
                    resolution: event.resolution as unknown as Record<string, unknown>,
                },
            }

        case "agent_stream":
            return null

        case "error":
            return {
                type: "daemon.error",
                payload: { message: event.message },
            }

        default:
            return null
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
        const result = await this.daemon.fetchAgents(options as Record<string, unknown>)
        return (result.entries ?? []).map((entry) =>
            mapAgentSnapshot(entry.agent as unknown as Record<string, unknown>),
        )
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
        return result as unknown as Record<string, unknown>
    }

    async getProvidersSnapshot(cwd?: string): Promise<Array<Record<string, unknown>>> {
        const result = await this.daemon.getProvidersSnapshot({ cwd })
        return (result.entries ?? []) as Array<Record<string, unknown>>
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
