import type { Event } from "@opencode-ai/sdk"
import type { PluginState } from "./state/types.js"
import type { Logger } from "./logger.js"
import type { PaseoTransport } from "./transport/types.js"
import type { Config } from "@opencode-ai/plugin"
import { listEphemeralWorkerIdsForSession, removeEphemeralWorkerRun, removeSession } from "./state/state.js"
export { createDaemonEventHandler } from "./hooks/daemon-events.js"
export { createToolDefinitionHandler } from "./hooks/tool-definition.js"

// ─── Event Handler Factory ───────────────────────────────────────────────────

export function createEventHandler(state: PluginState, client: PaseoTransport, logger: Logger, _config: unknown) {
  return async (input: { event: Event }) => {
    const event = input.event

    // Process opencode events (e.g., session lifecycle)
    if (event.type === "session.deleted") {
      const sessionId = event.properties.info.id
      if (sessionId) {
        const ephemeralWorkerIds = listEphemeralWorkerIdsForSession(state, sessionId)
        for (const workerId of ephemeralWorkerIds) {
          try {
            await client.cancelWorker(workerId)
          } catch (err: unknown) {
            logger.warn("Failed to cancel ephemeral worker during session cleanup", {
              sessionId,
              workerId,
              error: err instanceof Error ? err.message : String(err),
            })
          } finally {
            removeEphemeralWorkerRun(state, workerId)
          }
        }

        const removed = removeSession(state, sessionId)
        if (removed || ephemeralWorkerIds.length > 0) {
          logger.info("Session removed", { sessionId })
        }
      }
    }
  }
}

// ─── Config Handler Factory ──────────────────────────────────────────────────

export function createConfigHandler(_config: unknown, logger: Logger) {
  return (_opencodeConfig: Config) => {
    // Register Paseo plugin config section in opencode's config
    logger.debug("Config hook invoked")
    return Promise.resolve()
  }
}
