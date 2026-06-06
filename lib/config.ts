import { homedir } from "os"
import { join, dirname } from "path"
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "fs"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import { queueWarningToast } from "./toast.js"

const enabledSchema = z.boolean()
const debugSchema = z.boolean()
const daemonHostSchema = z.enum(["127.0.0.1", "localhost", "::1"])
const daemonPortSchema = z.number().int().min(1).max(65535)
const connectionTimeoutSchema = z.number().int().min(500).max(30000)
const passwordSchema = z.string()
const maxInboxItemsSchema = z.number().int().min(1).max(500)
const maxSummaryLengthSchema = z.number().int().min(50).max(5000)
const notificationsEnabledSchema = z.boolean()
const notificationsBlockingOnlySchema = z.boolean()
const notificationsStalledThresholdSchema = z.number().int().min(10000).max(3600000)
const defaultAgentSchema = z.string()
const defaultModelSchema = z.string()

const daemonShape = {
  host: daemonHostSchema.default("127.0.0.1"),
  port: daemonPortSchema.default(6767),
  connectionTimeoutMs: connectionTimeoutSchema.default(3000),
  password: passwordSchema.optional(),
} as const

const outputShape = {
  maxInboxItems: maxInboxItemsSchema.default(100),
  maxSummaryLength: maxSummaryLengthSchema.default(500),
} as const

const notificationsShape = {
  enabled: notificationsEnabledSchema.default(true),
  blockingOnly: notificationsBlockingOnlySchema.default(false),
  stalledThresholdMs: notificationsStalledThresholdSchema.default(120000),
} as const

const agentsShape = {
  defaultAgent: defaultAgentSchema.optional(),
  defaultModel: defaultModelSchema.optional(),
} as const

const daemonRuntimeSchema = z.object(daemonShape).strict()
const outputRuntimeSchema = z.object(outputShape).strict()
const notificationsRuntimeSchema = z.object(notificationsShape).strict()
const agentsRuntimeSchema = z.object(agentsShape).strict()

const daemonLayerSchema = z
  .object({
    host: daemonHostSchema.optional(),
    port: daemonPortSchema.optional(),
    connectionTimeoutMs: connectionTimeoutSchema.optional(),
    password: passwordSchema.optional(),
  })
  .strict()

const outputLayerSchema = z
  .object({
    maxInboxItems: maxInboxItemsSchema.optional(),
    maxSummaryLength: maxSummaryLengthSchema.optional(),
  })
  .strict()

const notificationsLayerSchema = z
  .object({
    enabled: notificationsEnabledSchema.optional(),
    blockingOnly: notificationsBlockingOnlySchema.optional(),
    stalledThresholdMs: notificationsStalledThresholdSchema.optional(),
  })
  .strict()

const agentsLayerSchema = z
  .object({
    defaultAgent: defaultAgentSchema.optional(),
    defaultModel: defaultModelSchema.optional(),
  })
  .strict()

const configRuntimeSchema = z
  .object({
    enabled: enabledSchema.default(true),
    debug: debugSchema.default(false),
    daemon: z.preprocess((value) => value ?? {}, daemonRuntimeSchema),
    output: z.preprocess((value) => value ?? {}, outputRuntimeSchema),
    notifications: z.preprocess((value) => value ?? {}, notificationsRuntimeSchema),
    agents: z.preprocess((value) => value ?? {}, agentsRuntimeSchema),
  })
  .strict()

const configLayerSchema = z
  .object({
    $schema: z.string().optional(),
    enabled: enabledSchema.optional(),
    debug: debugSchema.optional(),
    daemon: daemonLayerSchema.optional(),
    output: outputLayerSchema.optional(),
    notifications: notificationsLayerSchema.optional(),
    agents: agentsLayerSchema.optional(),
  })
  .strict()

export type DaemonConfig = z.infer<typeof daemonRuntimeSchema>
export type OutputConfig = z.infer<typeof outputRuntimeSchema>
export type NotificationsConfig = z.infer<typeof notificationsRuntimeSchema>
export type AgentsConfig = z.infer<typeof agentsRuntimeSchema>
export type PluginConfig = z.infer<typeof configRuntimeSchema>

type ConfigLayer = z.infer<typeof configLayerSchema>

const defaultConfig = configRuntimeSchema.parse({})

const CONFIG_WARNING_DELAY_MS = 7000

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode")
  : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "paseo.jsonc")

interface ValidationError {
  key: string
  expected: string
  actual: string
}

interface ConfigLoadResult {
  data: unknown
  parseError?: string
}

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
  const global = resolveConfigFileInDir(GLOBAL_CONFIG_DIR)
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const configDir = opencodeConfigDir ? resolveConfigFileInDir(opencodeConfigDir) : null

  let project: string | null = null
  if (ctx?.directory) {
    const opencodeDir = findOpencodeDir(ctx.directory)
    if (opencodeDir) {
      project = resolveConfigFileInDir(opencodeDir)
    }
  }

  return { global, configDir, project }
}

function resolveConfigFileInDir(dir: string): string | null {
  const jsonc = join(dir, "paseo.jsonc")
  if (existsSync(jsonc)) return jsonc
  const json = join(dir, "paseo.json")
  return existsSync(json) ? json : null
}

function formatParseErrors(errors: ParseError[]): string {
  if (errors.length === 0) {
    return "Invalid JSONC"
  }

  return errors
    .slice(0, 2)
    .map((error) => printParseErrorCode(error.error))
    .join(", ")
}

function loadConfigFile(configPath: string): ConfigLoadResult {
  let fileContent = ""
  try {
    fileContent = readFileSync(configPath, "utf-8")
  } catch {
    return { data: null }
  }

  const parseErrors: ParseError[] = []
  const parsed = parse(fileContent, parseErrors, { allowTrailingComma: true }) as unknown

  if (parseErrors.length > 0) {
    return { data: null, parseError: formatParseErrors(parseErrors) }
  }

  if (parsed === undefined || parsed === null) {
    return { data: null, parseError: "Config file is empty or invalid" }
  }

  return { data: parsed }
}

export function deepCloneConfig(config: PluginConfig): PluginConfig {
  return structuredClone(config)
}

function mergeLayer(config: PluginConfig, data: ConfigLayer): PluginConfig {
  const { $schema: _schema, ...configData } = data

  return configRuntimeSchema.parse({
    ...config,
    ...configData,
    daemon: { ...config.daemon, ...configData.daemon },
    output: { ...config.output, ...configData.output },
    notifications: { ...config.notifications, ...configData.notifications },
    agents: { ...config.agents, ...configData.agents },
  })
}

type ConfigLayerKind = "global" | "config-dir" | "project"

function getLayerLabel(layer: ConfigLayerKind): string {
  switch (layer) {
    case "global":
      return "global config"
    case "config-dir":
      return "config-dir config"
    case "project":
      return "project config"
  }
}

function queueConfigWarning(ctx: PluginInput, title: string, message: string): void {
  queueWarningToast(ctx, { title, message, delayMs: CONFIG_WARNING_DELAY_MS })
}

function showParseWarning(ctx: PluginInput, configPath: string, layer: ConfigLayerKind, error: string): void {
  queueConfigWarning(
    ctx,
    `Paseo: ${getLayerLabel(layer)} warning`,
    `${configPath}\nFailed to parse config file: ${error}`,
  )
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  const normalizedPath = path.filter(
    (segment): segment is string | number => typeof segment === "string" || typeof segment === "number",
  )

  return normalizedPath.length > 0 ? normalizedPath.join(".") : "config"
}

function formatValidationErrors(error: z.ZodError): string[] {
  return error.issues.slice(0, 3).map((issue) => {
    const path = formatIssuePath(issue.path)

    if (issue.code === "unrecognized_keys") {
      return `${path}: unknown keys ${issue.keys.join(", ")}`
    }

    return `${path}: ${issue.message}`
  })
}

function showValidationWarning(ctx: PluginInput, configPath: string, layer: ConfigLayerKind, error: z.ZodError): void {
  const messages = formatValidationErrors(error)
  const suffix = error.issues.length > messages.length ? `\n(+${error.issues.length - messages.length} more)` : ""

  queueConfigWarning(ctx, `Paseo: ${getLayerLabel(layer)} warning`, `${configPath}\n${messages.join("\n")}${suffix}`)
}

export function validateConfigTypes(data: unknown): ValidationError[] {
  const result = configLayerSchema.safeParse(data)
  if (result.success) {
    return []
  }

  return result.error.issues.map((issue) => {
    const key = formatIssuePath(issue.path)

    if (issue.code === "unrecognized_keys") {
      return {
        key,
        expected: "known config keys",
        actual: `unknown: ${issue.keys.join(", ")}`,
      }
    }

    return {
      key,
      expected: "valid config value",
      actual: issue.message,
    }
  })
}

function createDefaultConfig(): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }

  const configContent = `{
  "$schema": "https://raw.githubusercontent.com/bradsjm/opencode-paseo/refs/heads/main/paseo.schema.json",
  // Configure opencode-paseo here.
  // Only localhost daemon hosts are supported: 127.0.0.1, localhost, or ::1.
  // See README.md for supported keys and defaults.
}
`
  writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

export function getConfig(ctx: PluginInput): PluginConfig {
  let config = deepCloneConfig(defaultConfig)
  const configPaths = getConfigPaths(ctx)

  if (!configPaths.global) {
    createDefaultConfig()
  }

  const layers: Array<{ path: string | null; kind: ConfigLayerKind }> = [
    { path: configPaths.global, kind: "global" },
    { path: configPaths.configDir, kind: "config-dir" },
    { path: configPaths.project, kind: "project" },
  ]

  for (const layer of layers) {
    if (!layer.path) continue

    const result = loadConfigFile(layer.path)
    if (result.parseError) {
      showParseWarning(ctx, layer.path, layer.kind, result.parseError)
      continue
    }
    if (result.data === null) continue

    const parsedLayer = configLayerSchema.safeParse(result.data)
    if (!parsedLayer.success) {
      showValidationWarning(ctx, layer.path, layer.kind, parsedLayer.error)
      continue
    }

    config = mergeLayer(config, parsedLayer.data)
  }

  return config
}
