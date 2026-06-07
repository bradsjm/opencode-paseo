import type { WorkerStatus } from "./types.js"

/**
 * Normalize a daemon worker status into the plugin's worker status union.
 *
 * @param input - Status payload from the daemon.
 * @param input.status
 * @returns A normalized worker status value.
 */
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
