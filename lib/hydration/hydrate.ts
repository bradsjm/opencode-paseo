import type { PluginState, InboxEvent, TerminalSessionSummary } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import {
    setConnectionStatus,
    setCapabilities,
    upsertWorker,
    upsertTerminal,
    insertInboxEvent,
    mapAgentToWorkerSummary,
    buildBlockingMetadata,
} from "../state/state.js"

// ─── Startup Hydration ───────────────────────────────────────────────────────
// Fetches current agents (workers) and terminals from the daemon,
// seeds inbox with blocking items from current attention state.
// Server info (version, features) is already available from the hello handshake.
// Does NOT replay full history or synthesize noisy notifications.

export interface HydrationResult {
    workers: number
    terminals: number
    inboxSeeded: number
}

export async function hydrate(
    state: PluginState,
    client: PaseoTransport,
    logger: Logger,
): Promise<HydrationResult> {
    let workers = 0
    let terminals = 0
    let inboxSeeded = 0

    // 1. Server info from handshake — set capabilities
    const serverInfo = client.getServerInfo()
    if (serverInfo) {
        const features = Object.keys(serverInfo.features).filter((k) => serverInfo.features[k])
        setCapabilities(state, {
            version: serverInfo.version,
            features,
            fetchedAt: Date.now(),
        })
        logger.info("Server info from handshake", {
            serverId: serverInfo.serverId,
            version: serverInfo.version,
            features,
        })
    } else {
        logger.warn("No server info available from handshake")
    }

    // 2. Agents (workers)
    try {
        const agents = await client.fetchAgents({
            subscribe: { subscriptionId: "opencode-paseo" },
        })
        for (const a of agents) {
            const worker = mapAgentToWorkerSummary(a)
            upsertWorker(state, worker)
            workers++

            if (worker.status === "blocked") {
                // Determine if the block is a permission request or a general question
                const hasPermissions = worker.pendingPermissionIds.length > 0
                const blockKind = hasPermissions ? "permission.requested" : "worker.blocked"
                const event: InboxEvent = {
                    id: `hydration-worker-blocked-${a.id}`,
                    kind: "worker.blocked",
                    resourceId: a.id,
                    blocking: true,
                    summary: a.attentionReason ?? `Worker "${a.title ?? a.id}" requires attention`,
                    read: false,
                    timestamp: Date.now(),
                    metadata: buildBlockingMetadata(blockKind, a.id, {
                        permissionId: hasPermissions ? worker.pendingPermissionIds[0] : undefined,
                    }),
                }
                if (insertInboxEvent(state, event)) {
                    inboxSeeded++
                }
            }
        }
        logger.info("Hydrated agents", { count: workers })
    } catch (err: any) {
        logger.warn("Agent hydration failed", err.message)
    }

    // 3. Terminals
    try {
        const terminalList = await client.listTerminals()
        for (const t of terminalList) {
            const terminal: TerminalSessionSummary = {
                id: t.id,
                title: t.title ?? t.name ?? t.id,
                cwd: "",
                status: "unknown" as TerminalSessionSummary["status"],
                lineCount: 0,
                lastReadCursor: 0,
            }
            upsertTerminal(state, terminal)
            terminals++
        }
        logger.info("Hydrated terminals", { count: terminals })
    } catch (err: any) {
        logger.warn("Terminal hydration failed", err.message)
    }

    setConnectionStatus(state, "connected")
    logger.info("Hydration complete", { workers, terminals, inboxSeeded })

    return { workers, terminals, inboxSeeded }
}
