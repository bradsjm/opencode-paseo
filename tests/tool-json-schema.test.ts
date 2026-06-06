import test from "node:test"
import assert from "node:assert/strict"
import { createToolArgsJsonSchema } from "../lib/tools/json-schema.js"
import { createTerminalCaptureTool } from "../lib/tools/terminal.js"
import { createWorkerCreateTool, createWorkerUpdateTool } from "../lib/tools/worker.js"
import { createScheduleCreateTool } from "../lib/tools/schedule.js"
import { createStatusTool } from "../lib/tools/status.js"
import { createPluginState } from "../lib/state/state.js"
import { Logger } from "../lib/logger.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import type { WorkerLaunchQueueController } from "../lib/worker-launch/queue.js"
import type { OpencodeClient } from "../lib/profile.js"

function createMockTransport(): PaseoTransport {
  return {
    isConnected: () => true,
    connect: async () => {},
    close: async () => {},
    getServerInfo: () => null,
    fetchAgents: async () => [],
    listTerminals: async () => [],
    getStatus: async () => ({}),
    getProvidersSnapshot: async () => [],
    onEvent: () => () => {},
    createTerminal: async () => ({ id: "t", name: "t" }),
    captureTerminal: async () => ({ terminalId: "t", lines: [], totalLines: 0 }),
    sendTerminalInput: () => {},
    killTerminal: async () => ({ id: "t", exitCode: null }),
    respondToPermission: async (opts) => ({
      workerId: opts.workerId,
      permissionId: opts.permissionId,
      behavior: opts.behavior,
    }),
    createChatRoom: async () => ({ requestId: "req", room: null, error: null }),
    listChatRooms: async () => ({ requestId: "req", rooms: [], error: null }),
    inspectChatRoom: async () => ({ requestId: "req", room: null, error: null }),
    deleteChatRoom: async () => ({ requestId: "req", room: null, error: null }),
    postChatMessage: async () => ({ requestId: "req", message: null, error: null }),
    readChatMessages: async () => ({ requestId: "req", messages: [], error: null }),
    waitForChatMessages: async () => ({ requestId: "req", messages: [], timedOut: true, error: null }),
    createWorker: async () => ({
      id: "w",
      provider: "test",
      cwd: "/tmp",
      model: null,
      status: "running" as const,
      title: null,
    }),
    runWorker: async () => ({
      id: "w-run",
      provider: "test",
      cwd: "/tmp",
      model: null,
      status: "running" as const,
      title: null,
    }),
    sendWorkerMessage: async () => {},
    waitForWorker: async () => ({
      status: "idle" as const,
      workerId: "w",
      error: null,
      lastMessage: null,
      finalSnapshot: null,
    }),
    cancelWorker: async () => {},
    killWorker: async () => {},
    archiveWorker: async (workerId) => ({ workerId, archivedAt: new Date().toISOString() }),
    fetchWorker: async () => null,
    updateWorker: async (opts) => ({
      workerId: opts.workerId,
      updated: true,
      metadataUpdated: false,
      settingsUpdated: true,
      errors: [],
    }),
    fetchWorkerActivity: async (opts) => ({ workerId: opts.workerId, activity: null }),
    listWorktrees: async () => ({ requestId: "req", worktrees: [], error: null }),
    createWorktree: async () => ({ requestId: "req", workspace: null, error: null }),
    archiveWorktree: async () => ({ requestId: "req", success: true, error: null }),
    loopRun: async () => ({ requestId: "req", loop: null, error: null }),
    loopList: async () => ({ requestId: "req", loops: [], error: null }),
    loopInspect: async () => ({ requestId: "req", loop: null, error: null }),
    loopLogs: async () => ({ requestId: "req", loop: null, entries: [], nextCursor: null, error: null }),
    loopStop: async () => ({ requestId: "req", loop: null, error: null }),
    scheduleList: async () => ({ requestId: "req", schedules: [], error: null }),
    scheduleInspect: async () => ({ requestId: "req", schedule: null, error: null }),
    scheduleCreate: async () => ({ requestId: "req", schedule: null, error: null }),
    scheduleUpdate: async () => ({ requestId: "req", schedule: null, error: null }),
    schedulePause: async () => ({ requestId: "req", schedule: null, error: null }),
    scheduleResume: async () => ({ requestId: "req", schedule: null, error: null }),
    scheduleDelete: async () => ({ requestId: "req", scheduleId: "sched", error: null }),
    scheduleRunOnce: async () => ({ requestId: "req", schedule: null, error: null }),
    scheduleLogs: async () => ({ requestId: "req", runs: [], error: null }),
  }
}

function createMockOpencodeClient(): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
}

function createMockLaunchQueue(): WorkerLaunchQueueController {
  return {
    enqueueWorkerLaunch: () => ({
      launchId: "launch-1",
      status: "queued",
      position: 1,
      profile: "build",
      cwd: "/tmp",
      enqueuedAt: new Date().toISOString(),
      worktreeName: null,
      chatRoom: null,
    }),
    drainWorkerLaunchQueue: async () => {},
    getWorkerLaunchStatus: () => ({
      launchId: "launch-1",
      status: "queued",
      profile: "build",
      cwd: "/tmp",
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      worktreeName: null,
      chatRoom: null,
    }),
    observeWorker: () => {},
  }
}

test("createToolArgsJsonSchema", async (t) => {
  const logger = new Logger(false)
  const state = createPluginState()
  const client = createMockTransport()

  await t.test("keeps only terminalId required for paseo_terminal_capture", () => {
    const definition = createTerminalCaptureTool(state, client, logger)
    const jsonSchema = createToolArgsJsonSchema(definition.args)

    assert.equal(jsonSchema.type, "object")
    assert.equal("$schema" in jsonSchema, false)
    assert.deepEqual(jsonSchema.required, ["terminalId"])

    const properties = jsonSchema.properties as Record<string, unknown>
    assert.ok(properties.terminalId)
    assert.ok(properties.start)
    assert.ok(properties.end)
    assert.ok(properties.scrollback)
    assert.ok(properties.stripAnsi)
  })

  await t.test("preserves all-optional record fields for paseo_worker_create", () => {
    const definition = createWorkerCreateTool(createMockOpencodeClient(), createMockLaunchQueue(), logger)
    const jsonSchema = createToolArgsJsonSchema(definition.args)

    assert.ok(!Array.isArray(jsonSchema.required) || jsonSchema.required.length === 0)

    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    assert.ok(properties.labels)
    assert.equal(properties.labels.type, "object")
    assert.deepEqual(properties.labels.additionalProperties, { type: "string" })
  })

  await t.test("preserves nested optional and nullable settings for paseo_worker_update", () => {
    const definition = createWorkerUpdateTool(state, client, logger)
    const jsonSchema = createToolArgsJsonSchema(definition.args)

    assert.deepEqual(jsonSchema.required, ["workerId"])

    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    const settings = properties.settings
    assert.ok(settings)
    assert.equal(settings.type, "object")
    assert.ok(!Array.isArray(settings.required) || settings.required.length === 0)

    const settingsProperties = settings.properties as Record<string, Record<string, unknown>>
    assert.ok(settingsProperties.model)
    assert.ok(settingsProperties.thinkingOptionId)
    assert.ok(settingsProperties.features)
    assert.deepEqual(settingsProperties.model.anyOf, [{ type: "string" }, { type: "null" }])
    assert.deepEqual(settingsProperties.thinkingOptionId.anyOf, [{ type: "string" }, { type: "null" }])
    assert.deepEqual(settingsProperties.features.additionalProperties, {})
  })

  await t.test("preserves arrays and runtime-only conditional fields for paseo_schedule_create", () => {
    const definition = createScheduleCreateTool(state, client, createMockOpencodeClient(), logger)
    const jsonSchema = createToolArgsJsonSchema(definition.args)

    assert.deepEqual(jsonSchema.required, ["prompt", "cadenceType", "targetType"])

    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    assert.ok(properties.agentId)
    assert.ok(properties.profile)
    assert.ok(properties.everyMs)
    assert.equal(properties.agentId.type, "string")
    assert.equal(properties.profile.type, "string")
    assert.equal(properties.everyMs.type, "integer")
  })

  await t.test("emits a valid no-arg object schema for paseo_status", () => {
    const definition = createStatusTool(state, client, logger)
    const jsonSchema = createToolArgsJsonSchema(definition.args)

    assert.equal(jsonSchema.type, "object")
    assert.ok(!Array.isArray(jsonSchema.required) || jsonSchema.required.length === 0)
    assert.deepEqual(jsonSchema.properties, {})
  })
})
