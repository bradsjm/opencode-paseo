import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { Logger } from "../logger.js"
import type { PaseoTransport } from "../transport/types.js"

function normalizeRequiredString(value: string, field: string): string {
    const normalized = value.trim()
    if (!normalized) {
        throw new Error(`${field} must not be empty`)
    }
    return normalized
}

function normalizeOptionalString(value: string | undefined, field: string): string | undefined {
    if (value === undefined) {
        return undefined
    }
    return normalizeRequiredString(value, field)
}

function normalizePositiveInteger(value: number | undefined, field: string): number | undefined {
    if (value === undefined) {
        return undefined
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer`)
    }
    return value
}

function normalizeNonNegativeInteger(value: number | undefined, field: string): number | undefined {
    if (value === undefined) {
        return undefined
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer`)
    }
    return value
}

function normalizeLoopId(id: string): string {
    return normalizeRequiredString(id, "id")
}

function normalizeVerifyChecks(verifyChecks: string[] | undefined): string[] | undefined {
    if (verifyChecks === undefined) {
        return undefined
    }

    const normalized = verifyChecks.map((command) => command.trim()).filter(Boolean)
    if (normalized.length === 0) {
        throw new Error("verifyChecks must contain at least one non-empty command")
    }

    return normalized
}

// ─── Loop Run Tool ────────────────────────────────────────────────────────────

export function createLoopRunTool(client: PaseoTransport, logger: Logger): ToolDefinition {
    return tool({
        description:
            "Run a daemon-native Paseo loop with required verification and bounded stop conditions.",
        args: {
            prompt: tool.schema.string().describe("Prompt for the loop worker"),
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory for the loop (defaults to session directory)"),
            provider: tool.schema
                .string()
                .optional()
                .describe("Provider override for the loop worker"),
            model: tool.schema.string().optional().describe("Model override for the loop worker"),
            modeId: tool.schema.string().optional().describe("Mode override for the loop worker"),
            verifierProvider: tool.schema
                .string()
                .optional()
                .describe("Provider override for the verifier worker"),
            verifierModel: tool.schema
                .string()
                .optional()
                .describe("Model override for the verifier worker"),
            verifierModeId: tool.schema
                .string()
                .optional()
                .describe("Mode override for the verifier worker"),
            verifyPrompt: tool.schema
                .string()
                .optional()
                .describe("Verifier prompt. Must be non-empty when provided."),
            verifyChecks: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe(
                    "Verifier commands. Must contain at least one non-empty command when provided.",
                ),
            name: tool.schema.string().optional().describe("Optional human-readable loop name"),
            sleepMs: tool.schema
                .number()
                .int()
                .optional()
                .describe("Sleep interval between loop iterations in milliseconds"),
            maxIterations: tool.schema
                .number()
                .int()
                .optional()
                .describe("Positive maximum iteration count before the loop stops"),
            maxTimeMs: tool.schema
                .number()
                .int()
                .optional()
                .describe("Positive maximum runtime in milliseconds before the loop stops"),
        },
        async execute(args, context: ToolContext) {
            const cwd = normalizeOptionalString(args.cwd ?? context.directory, "cwd")
            if (!cwd) {
                throw new Error("cwd is required")
            }

            const prompt = normalizeRequiredString(args.prompt, "prompt")
            const provider = normalizeOptionalString(args.provider, "provider")
            const model = normalizeOptionalString(args.model, "model")
            const modeId = normalizeOptionalString(args.modeId, "modeId")
            const verifierProvider = normalizeOptionalString(
                args.verifierProvider,
                "verifierProvider",
            )
            const verifierModel = normalizeOptionalString(args.verifierModel, "verifierModel")
            const verifierModeId = normalizeOptionalString(args.verifierModeId, "verifierModeId")
            const verifyPrompt = normalizeOptionalString(args.verifyPrompt, "verifyPrompt")
            const verifyChecks = normalizeVerifyChecks(args.verifyChecks)
            const name = normalizeOptionalString(args.name, "name")
            const sleepMs = normalizePositiveInteger(args.sleepMs, "sleepMs")
            const maxIterations = normalizePositiveInteger(args.maxIterations, "maxIterations")
            const maxTimeMs = normalizePositiveInteger(args.maxTimeMs, "maxTimeMs")

            if (!verifyPrompt && !verifyChecks) {
                throw new Error(
                    "at least one verification mechanism is required: verifyPrompt or verifyChecks",
                )
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
                ...(provider !== undefined ? { provider } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(modeId !== undefined ? { modeId } : {}),
                ...(verifierProvider !== undefined ? { verifierProvider } : {}),
                ...(verifierModel !== undefined ? { verifierModel } : {}),
                ...(verifierModeId !== undefined ? { verifierModeId } : {}),
                ...(verifyPrompt !== undefined ? { verifyPrompt } : {}),
                ...(verifyChecks !== undefined ? { verifyChecks } : {}),
                ...(name !== undefined ? { name } : {}),
                ...(sleepMs !== undefined ? { sleepMs } : {}),
                ...(maxIterations !== undefined ? { maxIterations } : {}),
                ...(maxTimeMs !== undefined ? { maxTimeMs } : {}),
            })

            return {
                title: `Loop Run: ${result.loop?.id ?? name ?? prompt}`,
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Loop List Tool ───────────────────────────────────────────────────────────

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

export function createLoopLogsTool(client: PaseoTransport, logger: Logger): ToolDefinition {
    return tool({
        description:
            "Read snapshot/cursor-based daemon-native loop logs for a specific loop by ID.",
        args: {
            id: tool.schema.string().describe("ID of the loop to read logs for"),
            afterSeq: tool.schema
                .number()
                .int()
                .optional()
                .describe("Only return log entries after this sequence number"),
        },
        async execute(args) {
            const id = normalizeLoopId(args.id)
            const afterSeq = normalizeNonNegativeInteger(args.afterSeq, "afterSeq")
            logger.info("Tool: paseo_loop_logs invoked", { id, afterSeq })
            const result = await client.loopLogs({
                id,
                ...(afterSeq !== undefined ? { afterSeq } : {}),
            })
            return {
                title: `Loop Logs: ${id}`,
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Loop Stop Tool ───────────────────────────────────────────────────────────

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
