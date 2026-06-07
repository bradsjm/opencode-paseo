import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import { markResourceEventsRead, removeWorkerFromState } from "../state/state.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { collapseNull, compactDefined, nullableOptional, optionalNonBlankString, optionalNumber } from "./args.js"

// ─── Worktree List Tool ──────────────────────────────────────────────────────

/**
 * Create the tool that lists worktrees for a project.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorktreeListTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "List Paseo worktrees for a project. Requires explicit directory context via cwd.",
    args: {
      cwd: nullableOptional(tool.schema.string()).describe(
        "Working directory of the project (defaults to session directory)",
      ),
    },
    async execute(args, context: ToolContext) {
      const cwd = optionalNonBlankString(args.cwd) ?? context.directory
      logger.info("Tool: paseo_worktree_list invoked", { cwd })

      const result = await client.listWorktrees({ cwd })

      return {
        title: "Paseo Worktrees",
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Worktree Create Tool ────────────────────────────────────────────────────

/**
 * Create the tool that creates a new worktree.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorktreeCreateTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Create a new Paseo worktree. Requires explicit directory context for the project.",
    args: {
      cwd: nullableOptional(tool.schema.string()).describe(
        "Working directory of the project (defaults to session directory)",
      ),
      projectId: nullableOptional(tool.schema.string()).describe("Project ID to create the worktree under"),
      worktreeSlug: nullableOptional(tool.schema.string()).describe("Slug/name for the worktree"),
      refName: nullableOptional(tool.schema.string()).describe("Git ref (branch/tag/commit) to base the worktree on"),
      action: nullableOptional(tool.schema.string()).describe("Action to perform on worktree creation"),
      githubPrNumber: nullableOptional(tool.schema.number().int()).describe(
        "GitHub PR number to associate with the worktree",
      ),
    },
    async execute(args, context: ToolContext) {
      const cwd = collapseNull(args.cwd) ?? context.directory
      const projectId = collapseNull(args.projectId)
      const worktreeSlug = collapseNull(args.worktreeSlug)
      const refName = collapseNull(args.refName)
      const action = collapseNull(args.action)
      const githubPrNumber = optionalNumber(args.githubPrNumber)
      logger.info("Tool: paseo_worktree_create invoked", {
        cwd,
        worktreeSlug,
      })

      if (!cwd) {
        throw new Error("cwd must be provided for worktree creation")
      }

      const result = await client.createWorktree({
        cwd,
        ...compactDefined({ projectId, worktreeSlug, refName, action, githubPrNumber }),
      })

      return {
        title: "Worktree Created",
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}

// ─── Worktree Archive Tool ───────────────────────────────────────────────────

/**
 * Create the tool that archives a worktree.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createWorktreeArchiveTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Archive a Paseo worktree. Requires explicit directory context for the project.",
    args: {
      worktreePath: tool.schema.string().describe("Path to the worktree to archive"),
      cwd: tool.schema
        .string()
        .nullable()
        .optional()
        .describe("Working directory of the project (defaults to session directory)"),
    },
    async execute(args, context: ToolContext) {
      const cwd = collapseNull(args.cwd) ?? context.directory
      const worktreePath = optionalNonBlankString(args.worktreePath)
      logger.info("Tool: paseo_worktree_archive invoked", {
        worktreePath,
        cwd,
      })

      if (!worktreePath) {
        throw new Error("worktreePath must be provided")
      }

      const result = await client.archiveWorktree({
        worktreePath,
        cwd,
      })

      for (const workerId of result.removedAgents ?? []) {
        markResourceEventsRead(state, workerId)
        removeWorkerFromState(state, workerId)
      }

      return {
        title: "Worktree Archived",
        output: JSON.stringify(result, null, 2),
      }
    },
  })
}
