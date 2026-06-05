import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { markEventRead } from "../state/state.js"

// ─── Permission Respond Tool ─────────────────────────────────────────────────

export function createPermissionRespondTool(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
): ToolDefinition {
  return tool({
    description:
      "Respond to a pending permission request from a Paseo worker. Use allow or deny to unblock the worker.",
    args: {
      workerId: tool.schema.string().describe("ID of the worker requesting permission"),
      permissionId: tool.schema.string().describe("ID of the permission request to respond to"),
      behavior: tool.schema.enum(["allow", "deny"] as const).describe("Whether to allow or deny the permission"),
      message: tool.schema.string().optional().describe("Optional message to include with a deny response"),
      interrupt: tool.schema.boolean().optional().describe("Whether to interrupt the worker on deny (default: false)"),
      selectedActionId: tool.schema
        .string()
        .optional()
        .describe("ID of a specific action to select from the permission request"),
    },
    async execute(args) {
      logger.info("Tool: paseo_permission_respond invoked", {
        workerId: args.workerId,
        permissionId: args.permissionId,
        behavior: args.behavior,
      })

      const result = await client.respondToPermission({
        workerId: args.workerId,
        permissionId: args.permissionId,
        behavior: args.behavior,
        ...(args.message !== undefined ? { message: args.message } : {}),
        ...(args.interrupt !== undefined ? { interrupt: args.interrupt } : {}),
        ...(args.selectedActionId !== undefined ? { selectedActionId: args.selectedActionId } : {}),
      })

      // Mark matching permission events as read
      for (const [id, evt] of state.inbox) {
        if (evt.kind === "permission.requested" && evt.resourceId === args.workerId && !evt.read) {
          const metaPermId = evt.metadata?.permissionId as string | undefined
          if (metaPermId === args.permissionId) {
            markEventRead(state, id)
          }
        }
      }

      // Update worker's pending permission list
      const worker = state.workers.get(args.workerId)
      if (worker) {
        worker.pendingPermissionIds = worker.pendingPermissionIds.filter((id) => id !== args.permissionId)
        worker.pendingPermissions = worker.pendingPermissions.filter((p) => p.id !== args.permissionId)
      }

      return {
        title: "Permission Response Sent",
        output: JSON.stringify(
          {
            workerId: result.workerId,
            permissionId: result.permissionId,
            behavior: result.behavior,
            message: `Permission ${result.behavior === "allow" ? "allowed" : "denied"}. Worker ${result.workerId} may continue.`,
          },
          null,
          2,
        ),
      }
    },
  })
}
