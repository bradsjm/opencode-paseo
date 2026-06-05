import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { Logger } from "../logger.js"
import {
    formatProfileModelLabel,
    listProfiles,
    summarizeProfilePermissions,
    DEFAULT_PROFILE,
    type OpencodeClient,
} from "../profile.js"

// ─── Profile List Tool ───────────────────────────────────────────────────────

export function createProfileListTool(opencodeClient: OpencodeClient, logger: Logger): ToolDefinition {
    return tool({
        description:
            "List available OpenCode agent profiles for the current workspace. " +
            "Profiles define the model, mode, and behavior for Paseo workers. " +
            `Use a profile name from this list when calling paseo_worker_create. ` +
            `The default/recommended profile is "${DEFAULT_PROFILE}".`,
        args: {},
        async execute(_args, context: ToolContext) {
            logger.info("Tool: paseo_profile_list invoked", {
                directory: context.directory,
            })

            const profiles = await listProfiles(opencodeClient, context.directory)

            const output = profiles.map((p) => ({
                name: p.name,
                description: p.description,
                mode: p.mode,
                model: formatProfileModelLabel(p),
                permissionSummary: summarizeProfilePermissions(p),
            }))

            const hasDefaultProfile = output.some((p) => p.name === DEFAULT_PROFILE)

            return {
                title: "OpenCode Profiles",
                output: JSON.stringify(
                    {
                        profiles: output,
                        count: output.length,
                        recommendation: hasDefaultProfile
                            ? `Use profile "${DEFAULT_PROFILE}" unless a different profile is needed.`
                            : `No "${DEFAULT_PROFILE}" profile found. Available: ${output.map((p) => p.name).join(", ") || "(none)"}`,
                    },
                    null,
                    2,
                ),
            }
        },
    })
}
