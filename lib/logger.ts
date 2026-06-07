import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, appendFileSync } from "fs"

const LOG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode", "logs", "paseo", "daily")
  : join(homedir(), ".config", "opencode", "logs", "paseo", "daily")

function ensureLogDir(): string {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
  return LOG_DIR
}

function formatDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatTimestamp(): string {
  return new Date().toISOString()
}

function compactData(data: unknown): string {
  if (data === undefined) return ""
  if (typeof data === "string") return data
  try {
    return JSON.stringify(data, null, 0)
  } catch {
    if (data instanceof Error) return data.message
    if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") return String(data)
    return "[unserializable]"
  }
}

/**
 * Writes timestamped Paseo log lines to the daily log file when debug mode is enabled.
 */
export class Logger {
  private enabled: boolean

  /**
   * Creates a logger instance.
   *
   * @param debug - Whether this logger writes to disk.
   * @returns A logger instance configured with the requested debug setting.
   */
  constructor(debug: boolean) {
    this.enabled = debug
  }

  private write(level: string, message: string, data?: unknown): void {
    if (!this.enabled) return

    const dir = ensureLogDir()
    const file = join(dir, `${formatDate()}.log`)
    const ts = formatTimestamp()
    const extra = data !== undefined ? ` ${compactData(data)}` : ""
    const line = `[${ts}] [${level}] ${message}${extra}\n`

    try {
      appendFileSync(file, line, "utf-8")
    } catch {
      // Silently fail — logging should never break plugin operation
    }
  }

  /**
   * Writes a log line with INFO severity.
   *
   * @param message - Message to append.
   * @param data - Optional structured data to serialize alongside the message.
   * @returns Nothing.
   */
  info(message: string, data?: unknown): void {
    this.write("INFO", message, data)
  }

  /**
   * Writes a log line with DEBUG severity.
   *
   * @param message - Message to append.
   * @param data - Optional structured data to serialize alongside the message.
   * @returns Nothing.
   */
  debug(message: string, data?: unknown): void {
    this.write("DEBUG", message, data)
  }

  /**
   * Writes a log line with WARN severity.
   *
   * @param message - Message to append.
   * @param data - Optional structured data to serialize alongside the message.
   * @returns Nothing.
   */
  warn(message: string, data?: unknown): void {
    this.write("WARN", message, data)
  }

  /**
   * Writes a log line with ERROR severity.
   *
   * @param message - Message to append.
   * @param data - Optional structured data to serialize alongside the message.
   * @returns Nothing.
   */
  error(message: string, data?: unknown): void {
    this.write("ERROR", message, data)
  }
}
