import type { Plugin } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { createPluginState, findTaskRunByWorkerId, resetPluginState } from "./lib/state/state.js"
import type { WorkerSummary } from "./lib/state/types.js"
import { PaseoClient } from "./lib/transport/client.js"
import { hydrate } from "./lib/hydration/hydrate.js"
import { createStatusTool } from "./lib/tools/status.js"
import {
  createChatCreateTool,
  createChatDeleteTool,
  createChatInspectTool,
  createChatListTool,
  createChatPostTool,
  createChatReadTool,
  createChatWaitTool,
} from "./lib/tools/chat.js"
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
import { createTaskTool, watchBackgroundTaskCompletion } from "./lib/tools/task.js"
import { createWorktreeListTool, createWorktreeCreateTool, createWorktreeArchiveTool } from "./lib/tools/worktree.js"
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
import {
  createLoopRunTool,
  createLoopListTool,
  createLoopInspectTool,
  createLoopLogsTool,
  createLoopStopTool,
} from "./lib/tools/loop.js"
import {
  createEventHandler,
  createDaemonEventHandler,
  createConfigHandler,
  createToolDefinitionHandler,
} from "./lib/hooks.js"
import { createWorkerLaunchQueueController } from "./lib/worker-launch/queue.js"
import { createWorkerStallMonitor } from "./lib/worker-stall-monitor.js"
import { createChatWatcher } from "./lib/chat/watch.js"
import { createStartupWarningNotifier } from "./lib/toast.js"

const server: Plugin = (async (ctx) => {
  const config = getConfig(ctx)
  if (!config.enabled) return {}

  const logger = new Logger(config.debug)
  const state = createPluginState()
  const client = new PaseoClient(config.daemon)
  const notifyStartupWarning = createStartupWarningNotifier(ctx)
  const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

  // Attempt connection to Paseo daemon
  try {
    await client.connect()
  } catch (err: unknown) {
    logger.warn("Paseo plugin not loading because Paseo daemon was not found", getErrorMessage(err))
    notifyStartupWarning(
      "Paseo daemon unavailable",
      `Could not connect to Paseo daemon at ${config.daemon.host}:${config.daemon.port}. Paseo tools were not loaded.`,
    )
    return {}
  }

  logger.info("Paseo plugin initializing")
  logger.info("Connected to Paseo daemon")

  // Hydrate state from daemon
  const hydration = await hydrate(state, client, logger, config.output, undefined, (worker) => {
    if (config.task.enabled && shouldWatchTaskWorker(worker, { allowIdleRecovery: true })) {
      watchBackgroundTaskCompletion(state, client, ctx.client, logger, worker.id)
    }
  })
  logger.info("Hydration complete", hydration)

  const chatWatcher = createChatWatcher(state, client, ctx.client, logger, config)
  for (const worker of state.workers.values()) {
    chatWatcher.observeWorker(worker)
  }

  const workerLaunchQueue = createWorkerLaunchQueueController(state, client, config, ctx.client, logger, (worker) =>
    chatWatcher.observeWorker(worker),
  )
  const observeWorker = (worker: WorkerSummary, observedLaunchId?: string) => {
    chatWatcher.observeWorker(worker)
    workerLaunchQueue.observeWorker(worker, observedLaunchId)
  }

  // Attach live event listener
  const daemonEventHandler = createDaemonEventHandler(state, logger, config, ctx.client, observeWorker, (worker) => {
    if (config.task.enabled && shouldWatchTaskWorker(worker)) {
      watchBackgroundTaskCompletion(state, client, ctx.client, logger, worker.id)
    }
  })

  function shouldWatchTaskWorker(worker: WorkerSummary, options: { allowIdleRecovery?: boolean } = {}): boolean {
    const taskRun = findTaskRunByWorkerId(state, worker.id)
    if (!taskRun?.background || taskRun.completionInjected) return false
    if (worker.status === "idle" || worker.status === "error") return options.allowIdleRecovery === true
    return worker.status !== "closed"
  }
  const stallMonitor = createWorkerStallMonitor(state, logger, config, daemonEventHandler)
  stallMonitor.seedFromWorkers()
  client.onEvent((event) => {
    daemonEventHandler(event)
    stallMonitor.observeEvent(event)
  })
  stallMonitor.start()
  logger.info("Live event subscription active")

  const tools: Record<string, ToolDefinition> = {
    paseo_status: createStatusTool(state, client, logger),
    paseo_chat_create: createChatCreateTool(client, logger),
    paseo_chat_list: createChatListTool(client, logger),
    paseo_chat_inspect: createChatInspectTool(client, logger),
    paseo_chat_delete: createChatDeleteTool(client, logger),
    paseo_chat_post: createChatPostTool(client, logger),
    paseo_chat_read: createChatReadTool(client, logger),
    paseo_chat_wait: createChatWaitTool(client, logger),
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
    paseo_worker_list: createWorkerListTool(state, client, logger, observeWorker),
    paseo_worker_create: createWorkerCreateTool(ctx.client, workerLaunchQueue, logger),
    paseo_worker_launch_status: createWorkerLaunchStatusTool(workerLaunchQueue, logger),
    paseo_worker_send: createWorkerSendTool(state, client, logger),
    paseo_worker_wait: createWorkerWaitTool(state, client, config, logger),
    paseo_worker_cancel: createWorkerCancelTool(state, client, logger),
    paseo_worker_archive: createWorkerArchiveTool(state, client, logger),
    paseo_worker_update: createWorkerUpdateTool(state, client, logger, observeWorker),
    paseo_worker_inspect: createWorkerInspectTool(state, client, logger, observeWorker),
    paseo_worktree_list: createWorktreeListTool(state, client, logger),
    paseo_worktree_create: createWorktreeCreateTool(state, client, logger),
    paseo_worktree_archive: createWorktreeArchiveTool(state, client, logger),
    paseo_loop_run: createLoopRunTool(client, logger),
    paseo_loop_list: createLoopListTool(client, logger),
    paseo_loop_inspect: createLoopInspectTool(client, logger),
    paseo_loop_logs: createLoopLogsTool(client, logger),
    paseo_loop_stop: createLoopStopTool(client, logger),
    paseo_schedule_list: createScheduleListTool(state, client, logger),
    paseo_schedule_inspect: createScheduleInspectTool(state, client, logger),
    paseo_schedule_create: createScheduleCreateTool(state, client, ctx.client, logger),
    paseo_schedule_update: createScheduleUpdateTool(state, client, ctx.client, logger),
    paseo_schedule_pause: createSchedulePauseTool(state, client, logger),
    paseo_schedule_resume: createScheduleResumeTool(state, client, logger),
    paseo_schedule_delete: createScheduleDeleteTool(state, client, logger),
    paseo_schedule_run_once: createScheduleRunOnceTool(state, client, logger),
    paseo_schedule_logs: createScheduleLogsTool(state, client, logger),
  }
  if (config.task.enabled) {
    tools.task = createTaskTool(state, client, ctx.client, logger)
  }

  return {
    dispose: async () => {
      stallMonitor.stop()
      await chatWatcher.dispose()
      try {
        await client.close()
        logger.info("Paseo client closed")
      } catch (err: unknown) {
        logger.error("Error closing Paseo client during dispose", getErrorMessage(err))
      }
      resetPluginState(state)
      logger.info("Paseo plugin disposed")
    },
    event: createEventHandler(state, client, logger, config),
    config: createConfigHandler(config, logger),
    "tool.definition": createToolDefinitionHandler(config),
    tool: tools,
  }
}) satisfies Plugin

export default server
