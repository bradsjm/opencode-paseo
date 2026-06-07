/** Re-exports the normalized transport contract types. */
export type {
  ServerInfo,
  AgentSummary,
  FetchAgentsOptions,
  TerminalSummary,
  CreatedTerminal,
  TerminalCapture,
  KilledTerminal,
  PermissionResponse,
  CreateTerminalOptions,
  CaptureTerminalOptions,
  RespondPermissionOptions,
  DaemonEvent,
  DaemonEventCallback,
  PaseoTransport,
} from "./types.js"

/** Re-exports the Paseo transport client adapter. */
export { PaseoClient } from "./client.js"
