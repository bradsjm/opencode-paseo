import type { WorkerStatus } from "./types.js"

export function mapDaemonWorkerStatus(input: {
  status?: string
  requiresAttention?: boolean
  attentionReason?: string | null
  pendingPermissions?: unknown[]
}): WorkerStatus {
  const hasPendingPermissions = Array.isArray(input.pendingPermissions) && input.pendingPermissions.length > 0

  if (input.requiresAttention && (input.attentionReason === "permission" || hasPendingPermissions)) {
    return "blocked"
  }

  switch (input.status) {
    case "error":
      return "failed"
    case "closed":
      return "finished"
    case "initializing":
    case "running":
      return "running"
    case "idle":
      return "idle"
    default:
      return "unknown"
  }
}
