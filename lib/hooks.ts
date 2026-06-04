import type { Event } from "@opencode-ai/sdk"
import type { PluginState } from "./state/types.js"
import type { Logger } from "./logger.js"
import type { PaseoTransport } from "./transport/types.js"
import type { Config } from "@opencode-ai/plugin"
import { removeSession } from "./state/state.js"
export { createDaemonEventHandler } from "./hooks/daemon-events.js"

// ─── Event Handler Factory ───────────────────────────────────────────────────

export function createEventHandler(
    state: PluginState,
    _client: PaseoTransport,
    logger: Logger,
    _config: unknown,
) {
    return async (input: { event: Event }) => {
        const event = input.event

        // Process opencode events (e.g., session lifecycle)
        if (event.type === "session.deleted") {
            const sessionId = event.properties.info.id
            if (sessionId) {
                const removed = removeSession(state, sessionId)
                if (removed) {
                    logger.info("Session removed", { sessionId })
                }
            }
        }
    }
}

// ─── Config Handler Factory ──────────────────────────────────────────────────

export function createConfigHandler(_config: unknown, logger: Logger) {
    return async (_opencodeConfig: Config) => {
        // Register Paseo plugin config section in opencode's config
        logger.debug("Config hook invoked")
    }
}
