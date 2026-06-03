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
    CreateTerminalOptions,
    CreatedTerminal,
    CaptureTerminalOptions,
    TerminalCapture,
    KilledTerminal,
    RespondPermissionOptions,
    PermissionResponse,
    CreateWorkerOptions,
    CreatedWorker,
    WorkerWaitResult,
    ArchivedWorker,
    WorkerInspectResult,
    UpdateWorkerOptions,
    WorkerUpdateResult,
    WorkerActivityOptions,
    WorkerActivityResult,
    WorktreeListOptions,
    WorktreeCreateOptions,
    WorktreeArchiveOptions,
    ScheduleCreateOptions,
    ScheduleUpdateOptions,
    ScheduleInspectOptions,
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

    // ─── Terminal Operations ─────────────────────────────────────────────

    async createTerminal(options: CreateTerminalOptions): Promise<CreatedTerminal> {
        const result = await this.daemon.createTerminal(options.cwd, options.name, undefined, {
            agentId: options.agentId,
            command: options.command,
            args: options.args,
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
        const content = result.lines.join("\n")
        return {
            terminalId: result.terminalId,
            content,
            lineCount: result.totalLines,
            truncated: result.lines.length < result.totalLines,
        }
    }

    async sendTerminalInput(terminalId: string, input: string): Promise<void> {
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

    // ─── Worker Operations ───────────────────────────────────────────────

    async createWorker(options: CreateWorkerOptions): Promise<CreatedWorker> {
        const snapshot = await this.daemon.createAgent({
            provider: options.provider as Record<string, unknown> | undefined,
            cwd: options.cwd,
            initialPrompt: options.initialPrompt,
            labels: options.labels,
            worktree: options.worktree as Record<string, unknown> | undefined,
            worktreeName: options.worktreeName,
            ...(options.model || options.modeId
                ? {
                      config: {
                          ...(options.model ? { model: options.model } : {}),
                          ...(options.modeId ? { modeId: options.modeId } : {}),
                      } as Record<string, unknown>,
                  }
                : {}),
        } as Record<string, unknown>)
        const mapped = mapAgentSnapshot(snapshot as unknown as Record<string, unknown>)
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
            finalSnapshot: result.final
                ? mapAgentSnapshot(result.final as unknown as Record<string, unknown>)
                : null,
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
            agent: mapAgentSnapshot(result.agent as unknown as Record<string, unknown>),
            project: (result.project as Record<string, unknown>) ?? null,
        }
    }

    async killWorker(workerId: string): Promise<void> {
        // Upstream has no dedicated kill; cancelAgent is the closest permanent stop.
        await this.daemon.cancelAgent(workerId)
    }

    async updateWorker(options: UpdateWorkerOptions): Promise<WorkerUpdateResult> {
        const errors: string[] = []
        let metadataUpdated = false
        let settingsUpdated = false

        // Metadata: name and labels go through updateAgent
        if (options.name !== undefined || options.labels !== undefined) {
            try {
                const updates: { name?: string; labels?: Record<string, string> } = {}
                if (options.name !== undefined) updates.name = options.name
                if (options.labels !== undefined) updates.labels = options.labels
                await this.daemon.updateAgent(options.workerId, updates)
                metadataUpdated = true
            } catch (err: unknown) {
                errors.push(
                    `metadata update failed: ${err instanceof Error ? err.message : String(err)}`,
                )
            }
        }

        // Settings: each runtime setting has its own upstream RPC (independent try/catch)
        if (options.settings) {
            const s = options.settings
            let anySettingApplied = false

            if (s.modeId !== undefined) {
                try {
                    await this.daemon.setAgentMode(options.workerId, s.modeId)
                    anySettingApplied = true
                } catch (err: unknown) {
                    errors.push(
                        `setAgentMode failed: ${err instanceof Error ? err.message : String(err)}`,
                    )
                }
            }

            if (s.model !== undefined) {
                try {
                    await this.daemon.setAgentModel(options.workerId, s.model)
                    anySettingApplied = true
                } catch (err: unknown) {
                    errors.push(
                        `setAgentModel failed: ${err instanceof Error ? err.message : String(err)}`,
                    )
                }
            }

            if (s.thinkingOptionId !== undefined) {
                try {
                    await this.daemon.setAgentThinkingOption(options.workerId, s.thinkingOptionId)
                    anySettingApplied = true
                } catch (err: unknown) {
                    errors.push(
                        `setAgentThinkingOption failed: ${err instanceof Error ? err.message : String(err)}`,
                    )
                }
            }

            if (s.features) {
                for (const [featureId, value] of Object.entries(s.features)) {
                    try {
                        await this.daemon.setAgentFeature(options.workerId, featureId, value)
                        anySettingApplied = true
                    } catch (err: unknown) {
                        errors.push(
                            `setAgentFeature(${featureId}) failed: ${err instanceof Error ? err.message : String(err)}`,
                        )
                    }
                }
            }

            settingsUpdated = anySettingApplied
        }

        return {
            workerId: options.workerId,
            updated: metadataUpdated || settingsUpdated,
            metadataUpdated,
            settingsUpdated,
            errors,
        }
    }

    async fetchWorkerActivity(options: WorkerActivityOptions): Promise<WorkerActivityResult> {
        try {
            const timeline = await this.daemon.fetchAgentTimeline(options.workerId, {
                limit: options.limit,
            })
            return {
                workerId: options.workerId,
                timeline: timeline as unknown as Record<string, unknown>,
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.message.includes("not found")) {
                return { workerId: options.workerId, timeline: null }
            }
            throw err
        }
    }

    // ─── Worktree Operations ─────────────────────────────────────────────

    async listWorktrees(options: WorktreeListOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.getPaseoWorktreeList({
            cwd: options.cwd,
            repoRoot: options.repoRoot,
        })
        return result as unknown as Record<string, unknown>
    }

    async createWorktree(options: WorktreeCreateOptions): Promise<Record<string, unknown>> {
        const input: Record<string, unknown> = { cwd: options.cwd }
        if (options.projectId !== undefined) input.projectId = options.projectId
        if (options.worktreeSlug !== undefined) input.worktreeSlug = options.worktreeSlug
        if (options.refName !== undefined) input.refName = options.refName
        if (options.action !== undefined) input.action = options.action
        if (options.githubPrNumber !== undefined) input.githubPrNumber = options.githubPrNumber
        if (options.firstAgentContext !== undefined)
            input.firstAgentContext = options.firstAgentContext
        const result = await this.daemon.createPaseoWorktree(
            input as Parameters<typeof this.daemon.createPaseoWorktree>[0],
        )
        return result as unknown as Record<string, unknown>
    }

    async archiveWorktree(options: WorktreeArchiveOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.archivePaseoWorktree({
            worktreePath: options.worktreePath,
            repoRoot: options.repoRoot,
            branchName: options.branchName,
        })
        return result as unknown as Record<string, unknown>
    }

    // ─── Schedule Operations ─────────────────────────────────────────────

    async scheduleList(): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleList()
        return result as unknown as Record<string, unknown>
    }

    async scheduleInspect(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleInspect({ id: options.id })
        return result as unknown as Record<string, unknown>
    }

    async scheduleCreate(options: ScheduleCreateOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleCreate({
            prompt: options.prompt,
            name: options.name,
            cadence: options.cadence as unknown as Record<string, unknown>,
            target: options.target as unknown as Record<string, unknown>,
            maxRuns: options.maxRuns,
            expiresAt: options.expiresAt,
            runOnCreate: options.runOnCreate,
        } as Parameters<typeof this.daemon.scheduleCreate>[0])
        return result as unknown as Record<string, unknown>
    }

    async scheduleUpdate(options: ScheduleUpdateOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleUpdate({
            id: options.id,
            name: options.name,
            prompt: options.prompt,
            cadence: options.cadence as unknown as Record<string, unknown> | undefined,
            newAgentConfig: options.newAgentConfig as unknown as
                | Record<string, unknown>
                | undefined,
            maxRuns: options.maxRuns,
            expiresAt: options.expiresAt,
        } as Parameters<typeof this.daemon.scheduleUpdate>[0])
        return result as unknown as Record<string, unknown>
    }

    async schedulePause(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.schedulePause({ id: options.id })
        return result as unknown as Record<string, unknown>
    }

    async scheduleResume(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleResume({ id: options.id })
        return result as unknown as Record<string, unknown>
    }

    async scheduleDelete(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleDelete({ id: options.id })
        return result as unknown as Record<string, unknown>
    }

    async scheduleRunOnce(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleRunOnce({ id: options.id })
        return result as unknown as Record<string, unknown>
    }

    async scheduleLogs(options: ScheduleInspectOptions): Promise<Record<string, unknown>> {
        const result = await this.daemon.scheduleLogs({ id: options.id })
        return result as unknown as Record<string, unknown>
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
