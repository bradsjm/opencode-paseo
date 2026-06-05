import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import { removeWorkerFromState } from "../state/state.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"

// ─── Worktree List Tool ──────────────────────────────────────────────────────

export function createWorktreeListTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
    return tool({
        description: "List Paseo worktrees for a project. Requires explicit directory context via cwd or repoRoot.",
        args: {
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory of the project (defaults to session directory)"),
            repoRoot: tool.schema.string().optional().describe("Repository root path (alternative to cwd)"),
        },
        async execute(args, context: ToolContext) {
            const cwd = args.cwd ?? context.directory
            logger.info("Tool: paseo_worktree_list invoked", { cwd, repoRoot: args.repoRoot })

            if (!cwd && !args.repoRoot) {
                throw new Error("Either cwd or repoRoot must be provided")
            }

            const result = await client.listWorktrees({
                ...(cwd !== undefined ? { cwd } : {}),
                ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
            })

            return {
                title: "Paseo Worktrees",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Worktree Create Tool ────────────────────────────────────────────────────

export function createWorktreeCreateTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
    return tool({
        description: "Create a new Paseo worktree. Requires explicit directory context for the project.",
        args: {
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory of the project (defaults to session directory)"),
            projectId: tool.schema.string().optional().describe("Project ID to create the worktree under"),
            worktreeSlug: tool.schema.string().optional().describe("Slug/name for the worktree"),
            refName: tool.schema.string().optional().describe("Git ref (branch/tag/commit) to base the worktree on"),
            action: tool.schema.string().optional().describe("Action to perform on worktree creation"),
            githubPrNumber: tool.schema
                .number()
                .int()
                .optional()
                .describe("GitHub PR number to associate with the worktree"),
        },
        async execute(args, context: ToolContext) {
            const cwd = args.cwd ?? context.directory
            logger.info("Tool: paseo_worktree_create invoked", {
                cwd,
                worktreeSlug: args.worktreeSlug,
            })

            if (!cwd) {
                throw new Error("cwd must be provided for worktree creation")
            }

            const result = await client.createWorktree({
                cwd,
                ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
                ...(args.worktreeSlug !== undefined ? { worktreeSlug: args.worktreeSlug } : {}),
                ...(args.refName !== undefined ? { refName: args.refName } : {}),
                ...(args.action !== undefined ? { action: args.action } : {}),
                ...(args.githubPrNumber !== undefined ? { githubPrNumber: args.githubPrNumber } : {}),
            })

            return {
                title: "Worktree Created",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}

// ─── Worktree Archive Tool ───────────────────────────────────────────────────

export function createWorktreeArchiveTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
    return tool({
        description: "Archive a Paseo worktree. Requires explicit directory context or worktree identification.",
        args: {
            worktreePath: tool.schema.string().optional().describe("Path to the worktree to archive"),
            repoRoot: tool.schema.string().optional().describe("Repository root path"),
            branchName: tool.schema.string().optional().describe("Branch name of the worktree to archive"),
            cwd: tool.schema
                .string()
                .optional()
                .describe("Working directory (defaults to session directory, used as repoRoot fallback)"),
        },
        async execute(args, context: ToolContext) {
            const cwd = args.cwd ?? context.directory
            logger.info("Tool: paseo_worktree_archive invoked", {
                worktreePath: args.worktreePath,
                branchName: args.branchName,
            })

            if (!args.worktreePath && !args.branchName && !args.repoRoot) {
                throw new Error("At least one of worktreePath, branchName, or repoRoot must be provided")
            }

            const result = await client.archiveWorktree({
                ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
                repoRoot: args.repoRoot ?? cwd,
                ...(args.branchName !== undefined ? { branchName: args.branchName } : {}),
            })

            for (const workerId of result.removedAgents ?? []) {
                removeWorkerFromState(state, workerId)
            }

            return {
                title: "Worktree Archived",
                output: JSON.stringify(result, null, 2),
            }
        },
    })
}
