import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { Logger } from "../logger.js"
import type { PaseoTransport } from "../transport/types.js"
import {
  compactDefined,
  nullableOptional,
  optionalNumber,
  optionalTrimmedString,
  requiredTrimmedString,
} from "./args.js"

function normalizeOptionalString(value: string | null | undefined, field: string): string | undefined {
  const normalized = optionalTrimmedString(value)
  if (normalized !== undefined) {
    return normalized
  }
  if (value !== undefined && value !== null) {
    throw new Error(`${field} must not be empty`)
  }
  return undefined
}

function normalizePositiveInteger(value: number | null | undefined, field: string): number | undefined {
  const normalized = optionalNumber(value)
  if (normalized === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return normalized
}

function normalizeNonNegativeInteger(value: number | null | undefined, field: string): number | undefined {
  const normalized = optionalNumber(value)
  if (normalized === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return normalized
}

function normalizeLoopId(id: string): string {
  return requiredTrimmedString(id, "id")
}

function normalizeVerifyChecks(verifyChecks: string[] | null | undefined): string[] | undefined {
  if (verifyChecks === undefined || verifyChecks === null) {
    return undefined
  }

  const normalized = verifyChecks.map((command) => command.trim()).filter(Boolean)
  if (normalized.length === 0) {
    throw new Error("verifyChecks must contain at least one non-empty command")
  }

  return normalized
}

// ─── Loop Run Tool ────────────────────────────────────────────────────────────

/** Create the tool that runs a daemon-native Paseo loop.
 *
 * @param client - Transport used to start and manage the loop.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for running loops.
 */
export function createLoopRunTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Run a daemon-native Paseo loop with required verification and bounded stop conditions. Optional string fields " +
      "must be non-empty when provided. Verifier prompts should ask for explicit, checkable evidence from the worker " +
      "output or loop logs. verifyChecks validate command/process state; verifyPrompt validates semantic success. " +
      "Passing verifyChecks alone does not guarantee verifyPrompt success. " +
      "Loop-created agents cannot currently be parent-linked by this plugin because " +
      "the upstream loop payload exposes no labels field.",
    args: {
      prompt: tool.schema
        .string()
        .describe(
          "Self-contained loop worker prompt with objective, scope, acceptance criteria, and stop-worthy blockers",
        ),
      cwd: nullableOptional(tool.schema.string()).describe(
        "Working directory for the loop (defaults to session directory)",
      ),
      provider: nullableOptional(tool.schema.string()).describe("Provider override for the loop worker"),
      model: nullableOptional(tool.schema.string()).describe("Model override for the loop worker"),
      modeId: nullableOptional(tool.schema.string()).describe("Mode override for the loop worker"),
      verifierProvider: nullableOptional(tool.schema.string()).describe("Provider override for the verifier worker"),
      verifierModel: nullableOptional(tool.schema.string()).describe("Model override for the verifier worker"),
      verifierModeId: nullableOptional(tool.schema.string()).describe("Mode override for the verifier worker"),
      verifyPrompt: nullableOptional(tool.schema.string()).describe(
        "Verifier prompt with explicit pass/fail criteria based on worker output, loop logs, or command output. Must be non-empty when provided.",
      ),
      verifyChecks: tool.schema
        .array(tool.schema.string())
        .nullable()
        .optional()
        .describe(
          "Verifier commands for executable checks. Must contain at least one non-empty command when provided.",
        ),
      name: nullableOptional(tool.schema.string()).describe("Optional human-readable loop name"),
      sleepMs: nullableOptional(tool.schema.number().int()).describe(
        "Sleep interval between loop iterations in milliseconds",
      ),
      maxIterations: tool.schema
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Positive maximum iteration count before the loop stops"),
      maxTimeMs: tool.schema
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Positive maximum runtime in milliseconds before the loop stops"),
    },
    async execute(args, context: ToolContext) {
      const cwd = normalizeOptionalString(args.cwd ?? context.directory, "cwd")
      if (!cwd) {
        throw new Error("cwd is required")
      }

      const prompt = requiredTrimmedString(args.prompt, "prompt")
      const provider = normalizeOptionalString(args.provider, "provider")
      const model = normalizeOptionalString(args.model, "model")
      const modeId = normalizeOptionalString(args.modeId, "modeId")
      const verifierProvider = normalizeOptionalString(args.verifierProvider, "verifierProvider")
      const verifierModel = normalizeOptionalString(args.verifierModel, "verifierModel")
      const verifierModeId = normalizeOptionalString(args.verifierModeId, "verifierModeId")
      const verifyPrompt = normalizeOptionalString(args.verifyPrompt, "verifyPrompt")
      const verifyChecks = normalizeVerifyChecks(args.verifyChecks)
      const name = normalizeOptionalString(args.name, "name")
      const sleepMs = normalizePositiveInteger(args.sleepMs, "sleepMs")
      const maxIterations = normalizePositiveInteger(args.maxIterations, "maxIterations")
      const maxTimeMs = normalizePositiveInteger(args.maxTimeMs, "maxTimeMs")

      if (!verifyPrompt && !verifyChecks) {
        throw new Error("at least one verification mechanism is required: verifyPrompt or verifyChecks")
      }

      if (maxIterations === undefined && maxTimeMs === undefined) {
        throw new Error("at least one stop bound is required: maxIterations or maxTimeMs")
      }

      logger.info("Tool: paseo_loop_run invoked", {
        cwd,
        name,
        maxIterations,
        maxTimeMs,
      })

      const result = await client.loopRun({
        prompt,
        cwd,
        ...compactDefined({
          provider,
          model,
          modeId,
          verifierProvider,
          verifierModel,
          verifierModeId,
          verifyPrompt,
          verifyChecks,
          name,
          sleepMs,
          maxIterations,
          maxTimeMs,
        }),
      })

      return {
        title: `Loop Run: ${result.loop?.id ?? name ?? prompt}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Loop List Tool ───────────────────────────────────────────────────────────

/** Create the tool that lists daemon-native Paseo loops.
 *
 * @param client - Transport used to list loops.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for listing loops.
 */
export function createLoopListTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "List daemon-native Paseo loops managed by the daemon.",
    args: {},
    async execute() {
      logger.info("Tool: paseo_loop_list invoked")
      const result = await client.loopList()
      return {
        title: "Paseo Loops",
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Loop Inspect Tool ────────────────────────────────────────────────────────

/** Create the tool that inspects a daemon-native Paseo loop.
 *
 * @param client - Transport used to inspect the loop.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for inspecting loops.
 */
export function createLoopInspectTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Inspect a daemon-native Paseo loop by ID.",
    args: {
      id: tool.schema.string().describe("ID of the loop to inspect"),
    },
    async execute(args) {
      const id = normalizeLoopId(args.id)
      logger.info("Tool: paseo_loop_inspect invoked", { id })
      const result = await client.loopInspect({ id })
      return {
        title: `Loop: ${id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Loop Logs Tool ───────────────────────────────────────────────────────────

/** Create the tool that reads logs for a daemon-native Paseo loop.
 *
 * @param client - Transport used to read loop logs.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for reading loop logs.
 */
export function createLoopLogsTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Read snapshot/cursor-based daemon-native loop logs for a specific loop by ID.",
    args: {
      id: tool.schema.string().describe("ID of the loop to read logs for"),
      afterSeq: nullableOptional(tool.schema.number().int()).describe(
        "Only return log entries after this sequence number",
      ),
    },
    async execute(args) {
      const id = normalizeLoopId(args.id)
      const afterSeq = normalizeNonNegativeInteger(args.afterSeq, "afterSeq")
      logger.info("Tool: paseo_loop_logs invoked", { id, afterSeq })
      const result = await client.loopLogs({ id, ...compactDefined({ afterSeq }) })
      return {
        title: `Loop Logs: ${id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Loop Stop Tool ───────────────────────────────────────────────────────────

/** Create the tool that stops a daemon-native Paseo loop.
 *
 * @param client - Transport used to stop the loop.
 * @param logger - Logger used to record tool activity.
 * @returns A tool definition for stopping loops.
 */
export function createLoopStopTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Stop a daemon-native Paseo loop by ID.",
    args: {
      id: tool.schema.string().describe("ID of the loop to stop"),
    },
    async execute(args) {
      const id = normalizeLoopId(args.id)
      logger.info("Tool: paseo_loop_stop invoked", { id })
      const result = await client.loopStop({ id })
      return {
        title: `Loop Stop: ${id}`,
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}
