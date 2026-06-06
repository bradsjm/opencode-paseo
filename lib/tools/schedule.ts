import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport, ScheduleCadence, ScheduleTarget } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { listProfiles, profileToWorkerFields, resolveProfile, type OpencodeClient } from "../profile.js"

async function resolveScheduleProfileConfig(
  opencodeClient: OpencodeClient,
  profileName: string,
  cwd: string,
): Promise<{ provider: string; model?: string; modeId: string }> {
  const trimmedProfile = profileName.trim()
  if (!trimmedProfile) {
    throw new Error("profile must not be empty for 'new-agent' target")
  }

  const profiles = await listProfiles(opencodeClient, cwd)
  const profile = resolveProfile(profiles, trimmedProfile)
  return profileToWorkerFields(profile)
}

function ensureNonEmptyPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) {
    return undefined
  }
  if (!prompt.trim()) {
    throw new Error("prompt must not be empty")
  }
  return prompt
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed ? value : undefined
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
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
    ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
  }
}

async function resolveValidatedScheduleProfile(
  client: PaseoTransport,
  opencodeClient: OpencodeClient,
  logger: Logger,
  profileName: string,
  cwd: string,
) {
  const resolvedProfile = await resolveScheduleProfileConfig(opencodeClient, profileName, cwd)

  try {
    const providers = await client.getProvidersSnapshot(cwd)
    const found = providers.some((p) => p.id === resolvedProfile.provider || p.provider === resolvedProfile.provider)
    if (!found) {
      const available = providers
        .map((p) => p.id || p.provider)
        .filter(Boolean)
        .join(", ")
      throw new Error(
        `Provider "${resolvedProfile.provider}" not found in daemon provider snapshot for cwd "${cwd}". Available providers: ${available || "(none)"}`,
      )
    }
  } catch (err: any) {
    if (err.message?.includes("not found in daemon provider snapshot")) {
      throw err
    }
    logger.warn("Provider validation skipped due to snapshot fetch failure", err.message)
  }

  return resolvedProfile
}

// ─── Schedule List Tool ──────────────────────────────────────────────────────

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

// ─── Schedule Inspect Tool ───────────────────────────────────────────────────

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

// ─── Schedule Create Tool ────────────────────────────────────────────────────

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
      name: tool.schema.string().optional().describe("Human-readable name for the schedule"),
      cadenceType: tool.schema
        .enum(["every", "cron"])
        .describe("Cadence type: 'every' for interval-based, 'cron' for cron expression"),
      everyMs: tool.schema
        .number()
        .int()
        .optional()
        .describe("Interval in milliseconds (required when cadenceType is 'every')"),
      cronExpression: tool.schema.string().optional().describe("Cron expression (required when cadenceType is 'cron')"),
      timezone: tool.schema.string().optional().describe("IANA timezone for cron schedules (e.g. 'America/New_York')"),
      targetType: tool.schema
        .enum(["agent", "new-agent"])
        .describe("Target type: 'agent' (existing) or 'new-agent' (spawn new)"),
      agentId: tool.schema.string().optional().describe("Agent ID (required for 'agent' target type)"),
      profile: tool.schema
        .string()
        .optional()
        .describe("OpenCode profile name for 'new-agent' target. Required for scheduled new-agent runs."),
      cwd: tool.schema
        .string()
        .optional()
        .describe("Working directory (required for 'new-agent' target, defaults to session directory)"),
      maxRuns: tool.schema.number().int().optional().describe("Maximum number of executions before the schedule stops"),
      expiresAt: tool.schema.string().optional().describe("ISO 8601 timestamp after which the schedule stops"),
      runOnCreate: tool.schema.boolean().optional().describe("Whether to execute immediately upon creation"),
    },
    async execute(args, context: ToolContext) {
      logger.info("Tool: paseo_schedule_create invoked", {
        name: args.name,
        cadenceType: args.cadenceType,
        targetType: args.targetType,
      })

      ensureNonEmptyPrompt(args.prompt)
      const cadence = buildScheduleCadence({
        cadenceType: args.cadenceType,
        ...(args.everyMs !== undefined ? { everyMs: args.everyMs } : {}),
        ...(args.cronExpression !== undefined ? { cronExpression: args.cronExpression } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
      })
      if (!cadence) {
        throw new Error("cadenceType is required")
      }

      let target: ScheduleTarget

      switch (args.targetType) {
        case "agent":
          if (args.profile?.trim()) {
            throw new Error(`profile is only supported for target type 'new-agent'`)
          }
          if (!args.agentId) {
            throw new Error(`agentId is required for target type '${args.targetType}'`)
          }
          target = { type: args.targetType, agentId: args.agentId }
          break
        case "new-agent": {
          const cwd = args.cwd ?? context.directory
          if (!cwd) {
            throw new Error("cwd is required for 'new-agent' target")
          }
          if (!args.profile?.trim()) {
            throw new Error("profile is required for 'new-agent' target")
          }

          const resolvedProfile = await resolveValidatedScheduleProfile(
            client,
            opencodeClient,
            logger,
            args.profile,
            cwd,
          )

          target = {
            type: "new-agent",
            config: {
              provider: resolvedProfile.provider,
              cwd,
              ...(resolvedProfile.model !== undefined ? { model: resolvedProfile.model } : {}),
              modeId: resolvedProfile.modeId,
            },
          }
          break
        }
      }

      const result = await client.scheduleCreate({
        prompt: args.prompt,
        ...(args.name !== undefined ? { name: args.name } : {}),
        cadence,
        target,
        ...(args.maxRuns !== undefined ? { maxRuns: args.maxRuns } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
        ...(args.runOnCreate !== undefined ? { runOnCreate: args.runOnCreate } : {}),
      })

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

// ─── Schedule Update Tool ────────────────────────────────────────────────────

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
      name: tool.schema.string().optional().describe("New human-readable name"),
      prompt: tool.schema.string().optional().describe("New prompt for scheduled runs"),
      cadenceType: tool.schema.enum(["every", "cron"]).optional().describe("New cadence type"),
      everyMs: tool.schema.number().int().optional().describe("New interval in milliseconds (for 'every' cadence)"),
      cronExpression: tool.schema.string().optional().describe("New cron expression (for 'cron' cadence)"),
      timezone: tool.schema.string().optional().describe("New IANA timezone (for 'cron' cadence)"),
      profile: tool.schema.string().optional().describe("New OpenCode profile for new-agent schedules"),
      cwd: tool.schema.string().optional().describe("New working directory for new-agent schedules"),
      maxRuns: tool.schema.number().int().optional().describe("New maximum number of executions"),
      expiresAt: tool.schema.string().optional().describe("New ISO 8601 expiration timestamp"),
    },
    async execute(args, context: ToolContext) {
      logger.info("Tool: paseo_schedule_update invoked", { id: args.id })

      const prompt = optionalNonEmptyString(args.prompt)
      const cronExpression = optionalNonEmptyString(args.cronExpression)
      const timezone = optionalNonEmptyString(args.timezone)
      const profile = optionalNonEmptyString(args.profile)
      const cwd = optionalNonEmptyString(args.cwd)
      const expiresAt = optionalNonEmptyString(args.expiresAt)
      const everyMs = optionalPositiveInteger(args.everyMs)
      const maxRuns = optionalPositiveInteger(args.maxRuns)

      const cadence = buildScheduleCadence({
        ...(args.cadenceType !== undefined ? { cadenceType: args.cadenceType } : {}),
        ...(everyMs !== undefined ? { everyMs } : {}),
        ...(cronExpression !== undefined ? { cronExpression } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
      })

      // Build optional newAgentConfig
      let newAgentConfig: { provider?: string; model?: string | null; modeId?: string | null; cwd?: string } | undefined

      if (profile || cwd) {
        newAgentConfig = {
          ...(cwd !== undefined ? { cwd } : {}),
        }
      }

      ensureNonEmptyPrompt(prompt)

      // Resolve and validate profile-backed provider for newAgentConfig if provided
      if (newAgentConfig && profile) {
        const cwd = newAgentConfig.cwd ?? context.directory
        const resolvedProfile = await resolveValidatedScheduleProfile(client, opencodeClient, logger, profile, cwd)
        newAgentConfig.provider = resolvedProfile.provider
        newAgentConfig.model = resolvedProfile.model ?? null
        newAgentConfig.modeId = resolvedProfile.modeId ?? null
      }

      const result = await client.scheduleUpdate({
        id: args.id,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(cadence !== undefined ? { cadence } : {}),
        ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
        ...(maxRuns !== undefined ? { maxRuns } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })

      return {
        title: `Schedule Updated: ${args.id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Schedule Pause Tool ─────────────────────────────────────────────────────

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

// ─── Schedule Resume Tool ────────────────────────────────────────────────────

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

// ─── Schedule Delete Tool ────────────────────────────────────────────────────

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

// ─── Schedule Run Once Tool ──────────────────────────────────────────────────

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

// ─── Schedule Logs Tool ──────────────────────────────────────────────────────

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
