import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport, ScheduleCadence, ScheduleTarget } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { listProfiles, profileToWorkerFields, resolveProfile, type OpencodeClient } from "../profile.js"
import {
  collapseNull,
  compactDefined,
  nullableOptional,
  optionalNonBlankString,
  optionalNumber,
  requiredTrimmedString,
} from "./args.js"

async function resolveScheduleProfileConfig(
  opencodeClient: OpencodeClient,
  profileName: string,
  cwd: string,
): Promise<{ provider: string; model?: string; modeId: string }> {
  const trimmedProfile = requiredTrimmedString(profileName, "profile")

  const profiles = await listProfiles(opencodeClient, cwd)
  const profile = resolveProfile(profiles, trimmedProfile)
  return profileToWorkerFields(profile)
}

function ensureNonEmptyPrompt(prompt: string | null | undefined): string | undefined {
  if (prompt === undefined || prompt === null) {
    return undefined
  }
  requiredTrimmedString(prompt, "prompt")
  return prompt
}

function optionalPositiveInteger(value: number | null | undefined, fieldName: string): number | undefined {
  const normalized = optionalNumber(value)
  if (normalized === undefined) {
    return undefined
  }
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive integer`)
  }
  return normalized
}

function buildScheduleCadence(args: {
  cadenceType?: "every" | "cron"
  everyMs?: number
  cronExpression?: string
  timezone?: string
}): ScheduleCadence | undefined {
  if (!args.cadenceType) {
    return undefined
  }
  if (args.cadenceType === "every") {
    if (!args.everyMs || args.everyMs <= 0) {
      throw new Error("everyMs must be a positive integer for 'every' cadence")
    }
    return { type: "every", everyMs: args.everyMs }
  }
  if (!args.cronExpression?.trim()) {
    throw new Error("cronExpression must not be empty for 'cron' cadence")
  }
  return {
    type: "cron",
    expression: args.cronExpression,
    ...compactDefined({ timezone: args.timezone }),
  }
}

interface ScheduleCreateArgs {
  prompt: string
  name?: string | null
  cadenceType: "every" | "cron"
  everyMs?: number | null
  cronExpression?: string | null
  timezone?: string | null
  targetType: "agent" | "new-agent"
  agentId?: string | null
  profile?: string | null
  cwd?: string | null
  maxRuns?: number | null
  expiresAt?: string | null
  runOnCreate?: boolean | null
}

interface NormalizedScheduleCreateArgs {
  prompt: string
  name?: string
  everyMs?: number
  cronExpression?: string
  timezone?: string
  agentId?: string
  profile?: string
  cwd: string
  maxRuns?: number
  expiresAt?: string
  runOnCreate?: boolean
}

function normalizeScheduleCreateArgs(args: ScheduleCreateArgs, context: ToolContext): NormalizedScheduleCreateArgs {
  const prompt = ensureNonEmptyPrompt(args.prompt)
  if (!prompt) throw new Error("prompt must not be empty")
  return {
    prompt,
    ...compactDefined({
      name: collapseNull(args.name),
      everyMs: optionalPositiveInteger(args.everyMs, "everyMs"),
      cronExpression: collapseNull(args.cronExpression),
      timezone: collapseNull(args.timezone),
      agentId: collapseNull(args.agentId),
      profile: optionalNonBlankString(args.profile),
      maxRuns: optionalPositiveInteger(args.maxRuns, "maxRuns"),
      expiresAt: collapseNull(args.expiresAt),
      runOnCreate: collapseNull(args.runOnCreate),
    }),
    cwd: collapseNull(args.cwd) ?? context.directory,
  }
}

async function buildScheduleCreateTarget(
  args: ScheduleCreateArgs,
  normalized: NormalizedScheduleCreateArgs,
  opencodeClient: OpencodeClient,
): Promise<ScheduleTarget> {
  switch (args.targetType) {
    case "agent":
      return buildExistingAgentScheduleTarget(args.targetType, normalized.agentId, normalized.profile)
    case "new-agent":
      return buildNewAgentScheduleTarget(normalized.cwd, normalized.profile, opencodeClient)
  }
}

function buildExistingAgentScheduleTarget(
  targetType: "agent",
  agentId: string | undefined,
  profile: string | undefined,
) {
  if (profile) throw new Error(`profile is only supported for target type 'new-agent'`)
  if (!agentId) throw new Error(`agentId is required for target type '${targetType}'`)
  return { type: targetType, agentId }
}

async function buildNewAgentScheduleTarget(
  cwd: string | undefined,
  profile: string | undefined,
  opencodeClient: OpencodeClient,
): Promise<ScheduleTarget> {
  if (!cwd) throw new Error("cwd is required for 'new-agent' target")
  if (!profile) throw new Error("profile is required for 'new-agent' target")
  const resolvedProfile = await resolveScheduleProfileConfig(opencodeClient, profile, cwd)
  return {
    type: "new-agent",
    config: {
      provider: resolvedProfile.provider,
      cwd,
      modeId: resolvedProfile.modeId,
      ...compactDefined({ model: resolvedProfile.model }),
    },
  }
}

function buildScheduleCreatePayload(
  normalized: NormalizedScheduleCreateArgs,
  cadence: ScheduleCadence,
  target: ScheduleTarget,
) {
  return {
    prompt: normalized.prompt,
    cadence,
    target,
    ...compactDefined({
      name: normalized.name,
      maxRuns: normalized.maxRuns,
      expiresAt: normalized.expiresAt,
      runOnCreate: normalized.runOnCreate,
    }),
  }
}

interface ScheduleUpdateArgs {
  id: string
  name?: string | null
  prompt?: string | null
  cadenceType?: "every" | "cron" | null
  everyMs?: number | null
  cronExpression?: string | null
  timezone?: string | null
  profile?: string | null
  cwd?: string | null
  maxRuns?: number | null
  expiresAt?: string | null
}

interface ScheduleUpdateNormalizedFields {
  name?: string
  prompt?: string
  everyMs?: number
  cronExpression?: string
  timezone?: string
  profile?: string
  cwd?: string
  maxRuns?: number
  expiresAt?: string
}

function normalizeScheduleUpdateFields(args: ScheduleUpdateArgs): ScheduleUpdateNormalizedFields {
  return compactDefined({
    name: optionalNonBlankString(args.name),
    prompt: optionalNonBlankString(args.prompt),
    everyMs: optionalPositiveInteger(args.everyMs, "everyMs"),
    cronExpression: optionalNonBlankString(args.cronExpression),
    timezone: optionalNonBlankString(args.timezone),
    profile: optionalNonBlankString(args.profile),
    cwd: optionalNonBlankString(args.cwd),
    maxRuns: optionalPositiveInteger(args.maxRuns, "maxRuns"),
    expiresAt: optionalNonBlankString(args.expiresAt),
  })
}

function buildScheduleUpdateCadence(args: ScheduleUpdateArgs, normalized: ScheduleUpdateNormalizedFields) {
  if (args.cadenceType !== "every" && normalized.everyMs !== undefined) {
    throw new Error("everyMs is only supported when cadenceType is 'every'")
  }
  return buildScheduleCadence({
    ...compactDefined({
      cadenceType: args.cadenceType ?? undefined,
      everyMs: normalized.everyMs,
      cronExpression: normalized.cronExpression,
      timezone: normalized.timezone,
    }),
  })
}

async function resolveScheduleUpdateNewAgentConfig(
  normalized: ScheduleUpdateNormalizedFields,
  context: ToolContext,
  opencodeClient: OpencodeClient,
) {
  if (!normalized.profile && !normalized.cwd) return undefined
  const newAgentConfig: { provider?: string; model?: string | null; modeId?: string | null; cwd?: string } =
    compactDefined({ cwd: normalized.cwd })
  if (normalized.profile) {
    const cwd = newAgentConfig.cwd ?? context.directory
    const resolvedProfile = await resolveScheduleProfileConfig(opencodeClient, normalized.profile, cwd)
    newAgentConfig.provider = resolvedProfile.provider
    newAgentConfig.model = resolvedProfile.model ?? null
    newAgentConfig.modeId = resolvedProfile.modeId ?? null
  }
  return newAgentConfig
}

function buildScheduleUpdatePayload(
  args: ScheduleUpdateArgs,
  normalized: ScheduleUpdateNormalizedFields,
  cadence: ScheduleCadence | undefined,
  newAgentConfig: { provider?: string; model?: string | null; modeId?: string | null; cwd?: string } | undefined,
) {
  return {
    id: args.id,
    ...compactDefined({
      name: normalized.name,
      prompt: normalized.prompt,
      cadence,
      newAgentConfig,
      maxRuns: normalized.maxRuns,
      expiresAt: normalized.expiresAt,
    }),
  }
}

/**
 * Create the tool that lists all schedules known to the daemon.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleListTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "List all Paseo schedules managed by the daemon. Returns schedule entries with their cadence, target, and status.",
    args: {},
    async execute() {
      logger.info("Tool: paseo_schedule_list invoked")
      const result = await client.scheduleList()
      return {
        title: "Paseo Schedules",
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that inspects a single schedule by ID.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleInspectTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Inspect a specific Paseo schedule by ID. Returns full schedule configuration and status.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to inspect"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_inspect invoked", { id: args.id })
      const result = await client.scheduleInspect({ id: args.id })
      return {
        title: `Schedule: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that schedules a new recurring run.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param opencodeClient OpenCode client used to resolve profile configuration.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleCreateTool(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
): ToolDefinition {
  return tool({
    description:
      "Create a new Paseo schedule. Defines a recurring prompt execution with a cadence and target agent configuration. " +
      "Scheduled runs execute asynchronously. Use paseo_schedule_logs to inspect run history. Scheduled new-agent runs " +
      "cannot currently be parent-linked by this plugin because the upstream schedule payload exposes no labels field.",
    args: {
      prompt: tool.schema.string().describe("Prompt to execute on each scheduled run"),
      name: nullableOptional(tool.schema.string()).describe("Human-readable name for the schedule"),
      cadenceType: tool.schema
        .enum(["every", "cron"])
        .describe("Cadence type: 'every' for interval-based, 'cron' for cron expression"),
      everyMs: tool.schema
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Interval in milliseconds (required when cadenceType is 'every')"),
      cronExpression: nullableOptional(tool.schema.string()).describe(
        "Cron expression (required when cadenceType is 'cron')",
      ),
      timezone: nullableOptional(tool.schema.string()).describe(
        "IANA timezone for cron schedules (e.g. 'America/New_York')",
      ),
      targetType: tool.schema
        .enum(["agent", "new-agent"])
        .describe("Target type: 'agent' (existing) or 'new-agent' (spawn new)"),
      agentId: nullableOptional(tool.schema.string()).describe("Agent ID (required for 'agent' target type)"),
      profile: tool.schema
        .string()
        .nullable()
        .optional()
        .describe("OpenCode profile name for 'new-agent' target. Required for scheduled new-agent runs."),
      cwd: tool.schema
        .string()
        .nullable()
        .optional()
        .describe("Working directory (required for 'new-agent' target, defaults to session directory)"),
      maxRuns: nullableOptional(tool.schema.number().int()).describe(
        "Maximum number of executions before the schedule stops",
      ),
      expiresAt: nullableOptional(tool.schema.string()).describe("ISO 8601 timestamp after which the schedule stops"),
      runOnCreate: nullableOptional(tool.schema.boolean()).describe("Whether to execute immediately upon creation"),
    },
    async execute(args, context: ToolContext) {
      const normalized = normalizeScheduleCreateArgs(args, context)
      logger.info("Tool: paseo_schedule_create invoked", {
        name: normalized.name,
        cadenceType: args.cadenceType,
        targetType: args.targetType,
      })

      if (args.cadenceType !== "every" && normalized.everyMs !== undefined) {
        throw new Error("everyMs is only supported when cadenceType is 'every'")
      }

      const cadence = buildScheduleCadence({
        cadenceType: args.cadenceType,
        ...compactDefined({
          everyMs: normalized.everyMs,
          cronExpression: normalized.cronExpression,
          timezone: normalized.timezone,
        }),
      })
      if (!cadence) {
        throw new Error("cadenceType is required")
      }

      const target = await buildScheduleCreateTarget(args, normalized, opencodeClient)
      const result = await client.scheduleCreate(buildScheduleCreatePayload(normalized, cadence, target))

      return {
        title: "Schedule Created",
        output: JSON.stringify(
          {
            ...result,
            async:
              "Scheduled runs execute asynchronously. Use paseo_schedule_logs to inspect run history " +
              "and paseo_inbox_read to check for events.",
          },
          null,
          2,
        ),
      }
    },
  })
}

/**
 * Create the tool that updates an existing schedule.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param opencodeClient OpenCode client used to resolve updated new-agent profile configuration.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleUpdateTool(
  state: PluginState,
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
): ToolDefinition {
  return tool({
    description:
      "Update an existing Paseo schedule. Only provided fields are modified; omitted fields remain unchanged. " +
      "Scheduled new-agent runs cannot currently be parent-linked by this plugin because the upstream schedule payload " +
      "exposes no labels field.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to update"),
      name: nullableOptional(tool.schema.string()).describe("New human-readable name"),
      prompt: nullableOptional(tool.schema.string()).describe("New prompt for scheduled runs"),
      cadenceType: tool.schema.enum(["every", "cron"]).nullable().optional().describe("New cadence type"),
      everyMs: nullableOptional(tool.schema.number().int()).describe(
        "New interval in milliseconds (for 'every' cadence)",
      ),
      cronExpression: nullableOptional(tool.schema.string()).describe("New cron expression (for 'cron' cadence)"),
      timezone: nullableOptional(tool.schema.string()).describe("New IANA timezone (for 'cron' cadence)"),
      profile: nullableOptional(tool.schema.string()).describe("New OpenCode profile for new-agent schedules"),
      cwd: nullableOptional(tool.schema.string()).describe("New working directory for new-agent schedules"),
      maxRuns: nullableOptional(tool.schema.number().int()).describe("New maximum number of executions"),
      expiresAt: nullableOptional(tool.schema.string()).describe("New ISO 8601 expiration timestamp"),
    },
    async execute(args, context: ToolContext) {
      logger.info("Tool: paseo_schedule_update invoked", { id: args.id })

      const normalized = normalizeScheduleUpdateFields(args)
      ensureNonEmptyPrompt(normalized.prompt)
      const cadence = buildScheduleUpdateCadence(args, normalized)
      const newAgentConfig = await resolveScheduleUpdateNewAgentConfig(normalized, context, opencodeClient)
      const result = await client.scheduleUpdate(buildScheduleUpdatePayload(args, normalized, cadence, newAgentConfig))

      return {
        title: `Schedule Updated: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that pauses a schedule.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createSchedulePauseTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Pause a running Paseo schedule. The schedule remains configured but stops executing.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to pause"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_pause invoked", { id: args.id })
      const result = await client.schedulePause({ id: args.id })
      return {
        title: `Schedule Paused: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that resumes a paused schedule.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleResumeTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Resume a paused Paseo schedule. The schedule resumes executing on its configured cadence.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to resume"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_resume invoked", { id: args.id })
      const result = await client.scheduleResume({ id: args.id })
      return {
        title: `Schedule Resumed: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that deletes a schedule permanently.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleDeleteTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Delete a Paseo schedule permanently. The schedule and its history are removed.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to delete"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_delete invoked", { id: args.id })
      const result = await client.scheduleDelete({ id: args.id })
      return {
        title: `Schedule Deleted: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that triggers a one-time schedule run.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleRunOnceTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Trigger a single immediate execution of a Paseo schedule. Does not affect the regular cadence. " +
      "The triggered run executes asynchronously. A timeout warning after dispatch is not proof of failure; use " +
      "paseo_schedule_logs to confirm the final outcome.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to trigger"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_run_once invoked", { id: args.id })
      const result = await client.scheduleRunOnce({ id: args.id })
      return {
        title: `Schedule Run Once: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

/**
 * Create the tool that retrieves schedule execution logs.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createScheduleLogsTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Retrieve execution logs for a Paseo schedule. Returns recent run history and outcomes.",
    args: {
      id: tool.schema.string().describe("ID of the schedule to retrieve logs for"),
    },
    async execute(args) {
      logger.info("Tool: paseo_schedule_logs invoked", { id: args.id })
      const result = await client.scheduleLogs({ id: args.id })
      return {
        title: `Schedule Logs: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}
