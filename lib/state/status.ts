import type { WorkerStatus } from "./types.js"

export function mapDaemonWorkerStatus(input: { status?: string }): WorkerStatus {
  switch (input.status) {
    case "initializing":
    case "idle":
    case "running":
    case "error":
    case "closed":
      return input.status
    default:
      return "unknown"
  }
}
