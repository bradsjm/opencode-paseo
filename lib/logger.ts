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
    return new Date().toISOString().split("T")[0]
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
        return String(data)
    }
}

export class Logger {
    private enabled: boolean

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

    info(message: string, data?: unknown): void {
        this.write("INFO", message, data)
    }

    debug(message: string, data?: unknown): void {
        this.write("DEBUG", message, data)
    }

    warn(message: string, data?: unknown): void {
        this.write("WARN", message, data)
    }

    error(message: string, data?: unknown): void {
        this.write("ERROR", message, data)
    }
}
