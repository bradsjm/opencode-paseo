import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { createPluginState } from "./lib/state/state.js"
import { PaseoClient } from "./lib/transport/client.js"
import { hydrate } from "./lib/hydration/hydrate.js"
import { createStatusTool } from "./lib/tools/status.js"
import { createInboxReadTool, createInboxStatusTool } from "./lib/tools/inbox.js"
import { createEventHandler, createDaemonEventHandler, createConfigHandler } from "./lib/hooks.js"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)
    if (!config.enabled) return {}

    const logger = new Logger(config.debug)
    const state = createPluginState()
    const client = new PaseoClient(config.daemon)

    logger.info("Paseo plugin initializing")

    // Attempt connection to Paseo daemon
    try {
        await client.connect()
        logger.info("Connected to Paseo daemon")

        // Hydrate state from daemon
        const hydration = await hydrate(state, client, logger)
        logger.info("Hydration complete", hydration)

        // Attach live event listener
        const daemonEventHandler = createDaemonEventHandler(state, logger, config)
        client.onEvent(daemonEventHandler)
        logger.info("Live event subscription active")
    } catch (err: any) {
        logger.error("Failed to connect to Paseo daemon", err.message)
        state.connectionStatus = "error"
        state.lastError = err.message
    }

    return {
        event: createEventHandler(state, client, logger, config),
        config: createConfigHandler(config, logger),
        tool: {
            paseo_status: createStatusTool(state, client, logger),
            paseo_inbox_read: createInboxReadTool(state, logger),
            paseo_inbox_status: createInboxStatusTool(state, logger),
        },
    }
}) satisfies Plugin

export default server
