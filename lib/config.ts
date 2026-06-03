import { homedir } from "os"
import { join, dirname } from "path"
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

// ─── Config Interface ────────────────────────────────────────────────────────

export interface DaemonConfig {
    host: string
    port: number
    connectionTimeoutMs: number
    password?: string
}

export interface OutputConfig {
    maxInboxItems: number
    maxSummaryLength: number
}

export interface NotificationsConfig {
    enabled: boolean
    blockingOnly: boolean
}

export interface AgentsConfig {
    defaultAgent?: string
    defaultModel?: string
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    daemon: DaemonConfig
    output: OutputConfig
    notifications: NotificationsConfig
    agents: AgentsConfig
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "debug",
    "daemon",
    "output",
    "notifications",
    "agents",
])

const VALID_DAEMON_KEYS = new Set(["host", "port", "connectionTimeoutMs", "password"])
const VALID_OUTPUT_KEYS = new Set(["maxInboxItems", "maxSummaryLength"])
const VALID_NOTIFICATIONS_KEYS = new Set(["enabled", "blockingOnly"])
const VALID_AGENTS_KEYS = new Set(["defaultAgent", "defaultModel"])

export interface ValidationError {
    key: string
    expected: string
    actual: string
}

function getInvalidKeys(data: Record<string, any>, validKeys: Set<string>, prefix = ""): string[] {
    return Object.keys(data)
        .filter((k) => !validKeys.has(k))
        .map((k) => (prefix ? `${prefix}.${k}` : k))
}

export function validateConfigTypes(data: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof data.enabled })
    }
    if (data.debug !== undefined && typeof data.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof data.debug })
    }

    if (data.daemon !== undefined) {
        if (data.daemon === null || typeof data.daemon !== "object" || Array.isArray(data.daemon)) {
            errors.push({
                key: "daemon",
                expected: "object",
                actual: data.daemon === null ? "null" : typeof data.daemon,
            })
        } else {
            const invalid = getInvalidKeys(data.daemon, VALID_DAEMON_KEYS, "daemon")
            if (invalid.length > 0) {
                errors.push({
                    key: "daemon",
                    expected: `known keys [${[...VALID_DAEMON_KEYS]}]`,
                    actual: `unknown: ${invalid.join(", ")}`,
                })
            }
            if (data.daemon.host !== undefined && typeof data.daemon.host !== "string") {
                errors.push({
                    key: "daemon.host",
                    expected: "string",
                    actual: typeof data.daemon.host,
                })
            }
            if (
                data.daemon.port !== undefined &&
                (typeof data.daemon.port !== "number" || !Number.isInteger(data.daemon.port))
            ) {
                errors.push({
                    key: "daemon.port",
                    expected: "integer",
                    actual: typeof data.daemon.port,
                })
            }
            if (
                data.daemon.connectionTimeoutMs !== undefined &&
                (typeof data.daemon.connectionTimeoutMs !== "number" ||
                    !Number.isInteger(data.daemon.connectionTimeoutMs))
            ) {
                errors.push({
                    key: "daemon.connectionTimeoutMs",
                    expected: "integer",
                    actual: typeof data.daemon.connectionTimeoutMs,
                })
            }
            if (data.daemon.password !== undefined && typeof data.daemon.password !== "string") {
                errors.push({
                    key: "daemon.password",
                    expected: "string",
                    actual: typeof data.daemon.password,
                })
            }
        }
    }

    if (data.output !== undefined) {
        if (data.output === null || typeof data.output !== "object" || Array.isArray(data.output)) {
            errors.push({
                key: "output",
                expected: "object",
                actual: data.output === null ? "null" : typeof data.output,
            })
        } else {
            const invalid = getInvalidKeys(data.output, VALID_OUTPUT_KEYS, "output")
            if (invalid.length > 0) {
                errors.push({
                    key: "output",
                    expected: `known keys [${[...VALID_OUTPUT_KEYS]}]`,
                    actual: `unknown: ${invalid.join(", ")}`,
                })
            }
            if (
                data.output.maxInboxItems !== undefined &&
                (typeof data.output.maxInboxItems !== "number" ||
                    !Number.isInteger(data.output.maxInboxItems))
            ) {
                errors.push({
                    key: "output.maxInboxItems",
                    expected: "integer",
                    actual: typeof data.output.maxInboxItems,
                })
            }
            if (
                data.output.maxSummaryLength !== undefined &&
                (typeof data.output.maxSummaryLength !== "number" ||
                    !Number.isInteger(data.output.maxSummaryLength))
            ) {
                errors.push({
                    key: "output.maxSummaryLength",
                    expected: "integer",
                    actual: typeof data.output.maxSummaryLength,
                })
            }
        }
    }

    if (data.notifications !== undefined) {
        if (
            data.notifications === null ||
            typeof data.notifications !== "object" ||
            Array.isArray(data.notifications)
        ) {
            errors.push({
                key: "notifications",
                expected: "object",
                actual: data.notifications === null ? "null" : typeof data.notifications,
            })
        } else {
            const invalid = getInvalidKeys(
                data.notifications,
                VALID_NOTIFICATIONS_KEYS,
                "notifications",
            )
            if (invalid.length > 0) {
                errors.push({
                    key: "notifications",
                    expected: `known keys [${[...VALID_NOTIFICATIONS_KEYS]}]`,
                    actual: `unknown: ${invalid.join(", ")}`,
                })
            }
            if (
                data.notifications.enabled !== undefined &&
                typeof data.notifications.enabled !== "boolean"
            ) {
                errors.push({
                    key: "notifications.enabled",
                    expected: "boolean",
                    actual: typeof data.notifications.enabled,
                })
            }
            if (
                data.notifications.blockingOnly !== undefined &&
                typeof data.notifications.blockingOnly !== "boolean"
            ) {
                errors.push({
                    key: "notifications.blockingOnly",
                    expected: "boolean",
                    actual: typeof data.notifications.blockingOnly,
                })
            }
        }
    }

    if (data.agents !== undefined) {
        if (data.agents === null || typeof data.agents !== "object" || Array.isArray(data.agents)) {
            errors.push({
                key: "agents",
                expected: "object",
                actual: data.agents === null ? "null" : typeof data.agents,
            })
        } else {
            const invalid = getInvalidKeys(data.agents, VALID_AGENTS_KEYS, "agents")
            if (invalid.length > 0) {
                errors.push({
                    key: "agents",
                    expected: `known keys [${[...VALID_AGENTS_KEYS]}]`,
                    actual: `unknown: ${invalid.join(", ")}`,
                })
            }
            if (
                data.agents.defaultAgent !== undefined &&
                typeof data.agents.defaultAgent !== "string"
            ) {
                errors.push({
                    key: "agents.defaultAgent",
                    expected: "string",
                    actual: typeof data.agents.defaultAgent,
                })
            }
            if (
                data.agents.defaultModel !== undefined &&
                typeof data.agents.defaultModel !== "string"
            ) {
                errors.push({
                    key: "agents.defaultModel",
                    expected: "string",
                    actual: typeof data.agents.defaultModel,
                })
            }
        }
    }

    return errors
}

// ─── Localhost Enforcement ───────────────────────────────────────────────────

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

export function validateLocalhostOnly(host: string): ValidationError | null {
    if (!LOCALHOST_HOSTS.has(host)) {
        return {
            key: "daemon.host",
            expected: "localhost (127.0.0.1, localhost, ::1)",
            actual: host,
        }
    }
    return null
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    daemon: {
        host: "127.0.0.1",
        port: 6767,
        connectionTimeoutMs: 3000,
    },
    output: {
        maxInboxItems: 100,
        maxSummaryLength: 500,
    },
    notifications: {
        enabled: true,
        blockingOnly: false,
    },
    agents: {},
}

// ─── Config Paths ────────────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "paseo.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "paseo.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const jsonc = join(opencodeConfigDir, "paseo.jsonc")
        const json = join(opencodeConfigDir, "paseo.json")
        configDir = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const jsonc = join(opencodeDir, "paseo.jsonc")
            const json = join(opencodeDir, "paseo.json")
            project = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null
        }
    }

    return { global, configDir, project }
}

// ─── Config Loading ──────────────────────────────────────────────────────────

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        enabled: config.enabled,
        debug: config.debug,
        daemon: { ...config.daemon },
        output: { ...config.output },
        notifications: { ...config.notifications },
        agents: { ...config.agents },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        debug: data.debug ?? config.debug,
        daemon: {
            host: data.daemon?.host ?? config.daemon.host,
            port: data.daemon?.port ?? config.daemon.port,
            connectionTimeoutMs:
                data.daemon?.connectionTimeoutMs ?? config.daemon.connectionTimeoutMs,
            password: data.daemon?.password ?? config.daemon.password,
        },
        output: {
            maxInboxItems: data.output?.maxInboxItems ?? config.output.maxInboxItems,
            maxSummaryLength: data.output?.maxSummaryLength ?? config.output.maxSummaryLength,
        },
        notifications: {
            enabled: data.notifications?.enabled ?? config.notifications.enabled,
            blockingOnly: data.notifications?.blockingOnly ?? config.notifications.blockingOnly,
        },
        agents: {
            defaultAgent: data.agents?.defaultAgent ?? config.agents.defaultAgent,
            defaultModel: data.agents?.defaultModel ?? config.agents.defaultModel,
        },
    }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "./paseo.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidKeys(configData, VALID_CONFIG_KEYS)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) return

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `Paseo: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) continue

        const result = loadConfigFile(layer.path)
        if (result.parseError) continue
        if (!result.data) continue

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    // Enforce localhost-only
    const localhostError = validateLocalhostOnly(config.daemon.host)
    if (localhostError) {
        config.daemon.host = "127.0.0.1"
    }

    return config
}
