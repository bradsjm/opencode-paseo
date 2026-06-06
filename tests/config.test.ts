import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "os"
import type * as ConfigExports from "../lib/config.js"

type ConfigModule = typeof ConfigExports

function loadConfigModule(cacheKey: string): Promise<ConfigModule> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "lib", "config.ts"))
  moduleUrl.searchParams.set("t", cacheKey)
  return import(moduleUrl.href) as Promise<ConfigModule>
}

function createToastCollector() {
  const messages: string[] = []

  return {
    messages,
    ctx: {
      directory: "",
      client: {
        tui: {
          showToast: ({ body }: { body: { title: string; message: string } }) => {
            messages.push(`${body.title}\n${body.message}`)
          },
        },
      },
    },
  }
}

function getMessage(messages: string[], index: number): string {
  const message = messages[index]
  if (message === undefined) {
    throw new Error(`Expected message at index ${index}`)
  }
  return message
}

async function withImmediateTimers(run: () => Promise<void> | void) {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  try {
    await run()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
}

test("validateConfigTypes", async (t) => {
  const mod = await loadConfigModule("validate-config-types")

  await t.test("returns no errors for valid config", () => {
    const errors = mod.validateConfigTypes({
      enabled: true,
      debug: false,
      daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
    })
    assert.equal(errors.length, 0)
  })

  await t.test("detects wrong type for enabled", () => {
    const errors = mod.validateConfigTypes({ enabled: "yes" })
    assert.ok(errors.some((error) => error.key === "enabled"))
  })

  await t.test("detects unknown daemon keys", () => {
    const errors = mod.validateConfigTypes({ daemon: { unknownKey: true } })
    assert.ok(errors.some((error) => error.key === "daemon"))
  })

  await t.test("returns no errors for empty object", () => {
    const errors = mod.validateConfigTypes({})
    assert.equal(errors.length, 0)
  })
})

test("getConfig", async (t) => {
  let tempDir = ""
  let previousOpencodeConfigDir: string | undefined
  let previousXdgConfigHome: string | undefined

  t.beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-config-test-"))
    previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
  })

  t.afterEach(() => {
    if (previousOpencodeConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir
    }

    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }

    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test("returns schema-derived defaults when no config files exist", async () => {
    process.env.OPENCODE_CONFIG_DIR = join(tempDir, "missing")
    const mod = await loadConfigModule("defaults")
    const { ctx } = createToastCollector()
    ctx.directory = tempDir

    const config = mod.getConfig(ctx as any)

    assert.deepEqual(config, {
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
        stalledThresholdMs: 120000,
      },
      agents: {},
      task: {
        enabled: false,
      },
    })
  })

  await t.test("preserves layered deep-merge semantics across config sources", async () => {
    const configDir = join(tempDir, "config")
    const projectDir = join(tempDir, "project")
    const opencodeDir = join(projectDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(opencodeDir, { recursive: true })

    writeFileSync(
      join(configDir, "paseo.jsonc"),
      JSON.stringify({
        daemon: { port: 12345, connectionTimeoutMs: 6000 },
        notifications: { blockingOnly: true },
      }),
      "utf-8",
    )

    writeFileSync(
      join(opencodeDir, "paseo.jsonc"),
      JSON.stringify({
        daemon: { host: "localhost" },
        output: { maxInboxItems: 25 },
        agents: { defaultAgent: "worker-a" },
      }),
      "utf-8",
    )

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("merge")
    const { ctx } = createToastCollector()
    ctx.directory = projectDir

    const config = mod.getConfig(ctx as any)

    assert.equal(config.daemon.host, "localhost")
    assert.equal(config.daemon.port, 12345)
    assert.equal(config.daemon.connectionTimeoutMs, 6000)
    assert.equal(config.output.maxInboxItems, 25)
    assert.equal(config.output.maxSummaryLength, 500)
    assert.equal(config.notifications.enabled, true)
    assert.equal(config.notifications.blockingOnly, true)
    assert.equal(config.notifications.stalledThresholdMs, 120000)
    assert.equal(config.agents.defaultAgent, "worker-a")
    assert.equal(config.agents.defaultModel, undefined)
    assert.equal(config.task.enabled, false)
  })

  await t.test("accepts task.enabled override", async () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "paseo.jsonc"), JSON.stringify({ task: { enabled: true } }), "utf-8")

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("task-enabled")
    const { ctx } = createToastCollector()
    ctx.directory = tempDir

    const config = mod.getConfig(ctx as any)
    assert.equal(config.task.enabled, true)
  })

  await t.test("rejects unknown task keys", async () => {
    const errors = (await loadConfigModule("task-unknown")).validateConfigTypes({ task: { unknown: true } })
    assert.ok(errors.some((error) => error.key === "task"))
  })

  await t.test("accepts notifications.stalledThresholdMs overrides", async () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "paseo.jsonc"),
      JSON.stringify({ notifications: { stalledThresholdMs: 600000 } }),
      "utf-8",
    )

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("stalled-threshold-override")
    const { ctx } = createToastCollector()
    ctx.directory = tempDir

    const config = mod.getConfig(ctx as any)
    assert.equal(config.notifications.stalledThresholdMs, 600000)
  })

  await t.test("warns and skips invalid stalled threshold", async () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "paseo.jsonc"),
      JSON.stringify({ notifications: { stalledThresholdMs: 5000 } }),
      "utf-8",
    )

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("stalled-threshold-invalid")
    const { ctx, messages } = createToastCollector()
    ctx.directory = tempDir

    await withImmediateTimers(() => {
      const config = mod.getConfig(ctx as any)
      assert.equal(config.notifications.stalledThresholdMs, 120000)
    })

    assert.equal(messages.length, 1)
    assert.match(getMessage(messages, 0), /notifications\.stalledThresholdMs/i)
  })

  await t.test("warns on malformed config files instead of silently dropping them", async () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "paseo.jsonc"), '{"daemon": ', "utf-8")

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("parse-warning")
    const { ctx, messages } = createToastCollector()
    ctx.directory = tempDir

    await withImmediateTimers(() => {
      const config = mod.getConfig(ctx as any)
      assert.equal(config.daemon.port, 6767)
    })

    assert.equal(messages.length, 1)
    assert.match(getMessage(messages, 0), /Failed to parse config file/i)
    assert.match(getMessage(messages, 0), /config-dir config warning/i)
  })

  await t.test("warns and skips invalid config layers", async () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "paseo.jsonc"),
      JSON.stringify({ daemon: { port: "abc" }, output: { maxInboxItems: 20 } }),
      "utf-8",
    )

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("validation-warning")
    const { ctx, messages } = createToastCollector()
    ctx.directory = tempDir

    await withImmediateTimers(() => {
      const config = mod.getConfig(ctx as any)
      assert.equal(config.daemon.port, 6767)
      assert.equal(config.output.maxInboxItems, 100)
    })

    assert.equal(messages.length, 1)
    assert.match(getMessage(messages, 0), /daemon\.port/i)
    assert.match(getMessage(messages, 0), /config-dir config warning/i)
  })

  await t.test("rejects non-local daemon hosts from config", () => {
    const configDir = join(tempDir, "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "paseo.jsonc"), JSON.stringify({ daemon: { host: "192.168.1.10" } }), "utf-8")

    process.env.OPENCODE_CONFIG_DIR = configDir
    return loadConfigModule("non-local-host").then((mod) => {
      const { ctx, messages } = createToastCollector()
      ctx.directory = tempDir

      return withImmediateTimers(() => {
        const config = mod.getConfig(ctx as any)

        assert.equal(config.daemon.host, "127.0.0.1")
        assert.equal(messages.length, 1)
        assert.match(getMessage(messages, 0), /daemon\.host/i)
      })
    })
  })

  await t.test("labels project config warnings separately from config-dir warnings", async () => {
    const configDir = join(tempDir, "config")
    const projectDir = join(tempDir, "project")
    const opencodeDir = join(projectDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(join(configDir, "paseo.jsonc"), '{"daemon": ', "utf-8")
    writeFileSync(join(opencodeDir, "paseo.jsonc"), JSON.stringify({ daemon: { host: "bad-host" } }), "utf-8")

    process.env.OPENCODE_CONFIG_DIR = configDir
    const mod = await loadConfigModule("layer-labels")
    const { ctx, messages } = createToastCollector()
    ctx.directory = projectDir

    await withImmediateTimers(() => {
      const config = mod.getConfig(ctx as any)
      assert.equal(config.daemon.host, "127.0.0.1")
    })

    assert.equal(messages.length, 2)
    assert.match(getMessage(messages, 0), /config-dir config warning/i)
    assert.match(getMessage(messages, 1), /project config warning/i)
  })

  await t.test("creates a commented JSONC stub with a schema path", async () => {
    const xdgConfigHome = join(tempDir, "xdg")
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    const mod = await loadConfigModule("stub")
    const { ctx } = createToastCollector()
    ctx.directory = tempDir

    mod.getConfig(ctx as any)

    const stubPath = join(xdgConfigHome, "opencode", "paseo.jsonc")
    assert.equal(existsSync(stubPath), true)

    const content = readFileSync(stubPath, "utf-8")
    assert.match(
      content,
      /"\$schema": "https:\/\/raw\.githubusercontent\.com\/bradsjm\/opencode-paseo\/refs\/heads\/main\/paseo\.schema\.json"/,
    )
    assert.match(content, /Configure opencode-paseo here\./)
    assert.match(content, /Only localhost daemon hosts are supported/i)
  })
})
