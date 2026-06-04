import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { createPluginState } from "./lib/state/state.js"
import { PaseoClient } from "./lib/transport/client.js"
import { hydrate } from "./lib/hydration/hydrate.js"
import { createStatusTool } from "./lib/tools/status.js"
import { createInboxReadTool, createInboxStatusTool } from "./lib/tools/inbox.js"
import {
    createTerminalListTool,
    createTerminalCreateTool,
    createTerminalCaptureTool,
    createTerminalSendInputTool,
    createTerminalSendLinesTool,
    createTerminalKillTool,
} from "./lib/tools/terminal.js"
import { createPermissionRespondTool } from "./lib/tools/permission.js"
import { createProfileListTool } from "./lib/tools/profile.js"
import {
    createWorkerListTool,
    createWorkerCreateTool,
    createWorkerLaunchStatusTool,
    createWorkerSendTool,
    createWorkerWaitTool,
    createWorkerCancelTool,
    createWorkerArchiveTool,
    createWorkerUpdateTool,
    createWorkerInspectTool,
} from "./lib/tools/worker.js"
import {
    createWorktreeListTool,
    createWorktreeCreateTool,
    createWorktreeArchiveTool,
} from "./lib/tools/worktree.js"
import {
    createScheduleListTool,
    createScheduleInspectTool,
    createScheduleCreateTool,
    createScheduleUpdateTool,
    createSchedulePauseTool,
    createScheduleResumeTool,
    createScheduleDeleteTool,
    createScheduleRunOnceTool,
    createScheduleLogsTool,
} from "./lib/tools/schedule.js"
import { createEventHandler, createDaemonEventHandler, createConfigHandler } from "./lib/hooks.js"
import { resetPluginState } from "./lib/state/state.js"
import { createWorkerLaunchQueueController } from "./lib/worker-launch/queue.js"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)
    if (!config.enabled) return {}

    const logger = new Logger(config.debug)
    const state = createPluginState()
    const client = new PaseoClient(config.daemon)
    const workerLaunchQueue = createWorkerLaunchQueueController(state, client, ctx.client, logger)

    // Attempt connection to Paseo daemon
    try {
        await client.connect()
    } catch (err: any) {
        logger.warn("Paseo plugin not loading because Paseo daemon was not found", err.message)
        return {}
    }

    logger.info("Paseo plugin initializing")
    logger.info("Connected to Paseo daemon")

    // Hydrate state from daemon
    const hydration = await hydrate(state, client, logger, config.output)
    logger.info("Hydration complete", hydration)

    // Attach live event listener
    const daemonEventHandler = createDaemonEventHandler(state, logger, config, ctx.client)
    client.onEvent(daemonEventHandler)
    logger.info("Live event subscription active")

    return {
        dispose: async () => {
            try {
                await client.close()
                logger.info("Paseo client closed")
            } catch (err: any) {
                logger.error("Error closing Paseo client during dispose", err.message)
            }
            resetPluginState(state)
            logger.info("Paseo plugin disposed")
        },
        event: createEventHandler(state, client, logger, config),
        config: createConfigHandler(config, logger),
        tool: {
            paseo_status: createStatusTool(state, client, logger),
            paseo_inbox_read: createInboxReadTool(state, logger),
            paseo_inbox_status: createInboxStatusTool(state, logger),
            paseo_terminal_list: createTerminalListTool(state, client, logger),
            paseo_terminal_create: createTerminalCreateTool(state, client, logger),
            paseo_terminal_capture: createTerminalCaptureTool(state, client, logger),
            paseo_terminal_send_input: createTerminalSendInputTool(state, client, logger),
            paseo_terminal_send_lines: createTerminalSendLinesTool(state, client, logger),
            paseo_terminal_kill: createTerminalKillTool(state, client, logger),
            paseo_permission_respond: createPermissionRespondTool(state, client, logger),
            paseo_profile_list: createProfileListTool(ctx.client, logger),
            paseo_worker_list: createWorkerListTool(state, client, logger),
            paseo_worker_create: createWorkerCreateTool(ctx.client, workerLaunchQueue, logger),
            paseo_worker_launch_status: createWorkerLaunchStatusTool(workerLaunchQueue, logger),
            paseo_worker_send: createWorkerSendTool(state, client, logger),
            paseo_worker_wait: createWorkerWaitTool(state, client, config, logger),
            paseo_worker_cancel: createWorkerCancelTool(state, client, logger),
            paseo_worker_archive: createWorkerArchiveTool(state, client, logger),
            paseo_worker_update: createWorkerUpdateTool(state, client, logger),
            paseo_worker_inspect: createWorkerInspectTool(state, client, logger),
            paseo_worktree_list: createWorktreeListTool(state, client, logger),
            paseo_worktree_create: createWorktreeCreateTool(state, client, logger),
            paseo_worktree_archive: createWorktreeArchiveTool(state, client, logger),
            paseo_schedule_list: createScheduleListTool(state, client, logger),
            paseo_schedule_inspect: createScheduleInspectTool(state, client, logger),
            paseo_schedule_create: createScheduleCreateTool(state, client, ctx.client, logger),
            paseo_schedule_update: createScheduleUpdateTool(state, client, ctx.client, logger),
            paseo_schedule_pause: createSchedulePauseTool(state, client, logger),
            paseo_schedule_resume: createScheduleResumeTool(state, client, logger),
            paseo_schedule_delete: createScheduleDeleteTool(state, client, logger),
            paseo_schedule_run_once: createScheduleRunOnceTool(state, client, logger),
            paseo_schedule_logs: createScheduleLogsTool(state, client, logger),
        },
    }
}) satisfies Plugin

export default server
