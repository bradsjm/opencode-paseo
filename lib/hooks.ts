import type { Event } from "@opencode-ai/sdk"
import type { PluginState } from "./state/types.js"
import type { Logger } from "./logger.js"
import type { PaseoTransport } from "./transport/types.js"
import type { Config } from "@opencode-ai/plugin"
import {
  listEphemeralWorkerIdsForSession,
  listTaskRunsForSession,
  removeEphemeralWorkerRun,
  removeSession,
  removeTaskRun,
} from "./state/state.js"
import type { PluginConfig } from "./config.js"
import { TASK_TOOL_DESCRIPTION } from "./tools/task.js"
export { createDaemonEventHandler } from "./hooks/daemon-events.js"

// ─── Event Handler Factory ───────────────────────────────────────────────────

export function createEventHandler(state: PluginState, client: PaseoTransport, logger: Logger, _config: unknown) {
  return async (input: { event: Event }) => {
    const event = input.event

    // Process opencode events (e.g., session lifecycle)
    if (event.type === "session.deleted") {
      const sessionId = event.properties.info.id
      if (sessionId) {
        const workerIds = new Set([
          ...listEphemeralWorkerIdsForSession(state, sessionId),
          ...listTaskRunsForSession(state, sessionId).map((taskRun) => taskRun.workerId),
        ])
        for (const workerId of workerIds) {
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
        for (const taskRun of listTaskRunsForSession(state, sessionId)) {
          removeTaskRun(state, taskRun.taskSessionId)
        }

        const removed = removeSession(state, sessionId)
        if (removed || workerIds.size > 0) {
          logger.info("Session removed", { sessionId })
        }
      }
    }
  }
}

export function createToolDefinitionHandler(config: PluginConfig) {
  return (input: { toolID: string }, output: { description: string; parameters: unknown }) => {
    if (!config.task.enabled || input.toolID !== "task") return Promise.resolve()
    output.description = TASK_TOOL_DESCRIPTION
    return Promise.resolve()
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
