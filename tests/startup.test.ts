import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

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

test("plugin startup graceful degrade", async (t) => {
  await t.test("returns empty hooks and logs single warn when daemon is unreachable", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "opencode-paseo-startup-"))
    const configDir = join(tempRoot, "config")
    const projectDir = join(tempRoot, "project")
    const xdgConfigHome = join(tempRoot, "xdg")
    const logDir = join(xdgConfigHome, "opencode", "logs", "paseo", "daily")

    mkdirSync(configDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(xdgConfigHome, { recursive: true })
    const toasts: Array<{ title: string; message: string }> = []

    // Write a paseo config pointing to an unreachable daemon
    writeFileSync(
      join(configDir, "paseo.jsonc"),
      JSON.stringify({
        debug: true,
        daemon: {
          host: "127.0.0.1",
          port: 1,
          connectionTimeoutMs: 500,
        },
      }),
      "utf-8",
    )

    // Sandbox config and log paths
    const prevOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME

    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    try {
      // Dynamic import to pick up env overrides
      const { default: plugin } = await import("../index.js")

      // Construct minimal mock PluginInput
      const mockCtx = {
        client: {
          tui: {
            showToast: ({ body }: { body: { title: string; message: string } }) => {
              toasts.push(body)
            },
          },
        } as any,
        project: {} as any,
        directory: projectDir,
        worktree: projectDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:0"),
        $: {} as any,
      }

      let result: Awaited<ReturnType<typeof plugin>> | undefined
      await withImmediateTimers(async () => {
        result = await plugin(mockCtx, {})
      })

      // Should return empty hooks — no tool, event, config, dispose
      assert.equal(result?.tool, undefined, "expected no tool property")
      assert.equal(result?.event, undefined, "expected no event property")
      assert.equal(result?.config, undefined, "expected no config property")
      assert.equal(result?.dispose, undefined, "expected no dispose property")

      assert.equal(toasts.length, 1, "expected one startup warning toast")
      assert.equal(toasts[0]?.title, "Paseo daemon unavailable")
      assert.match(toasts[0]?.message ?? "", /127\.0\.0\.1:1/)
      assert.match(toasts[0]?.message ?? "", /Paseo tools were not loaded/i)

      // Verify single warn log message
      const logFiles = readdirSync(logDir).filter((name) => name.endsWith(".log"))
      assert.ok(logFiles.length > 0, "expected at least one debug log file")

      const logContent = readFileSync(join(logDir, logFiles[0]!), "utf-8")
      assert.match(
        logContent,
        /Paseo plugin not loading because Paseo daemon was not found/,
        "expected graceful degrade log message",
      )
      assert.doesNotMatch(
        logContent,
        /Paseo plugin initializing/,
        "should not log initializing message in no-daemon path",
      )
      assert.doesNotMatch(
        logContent,
        /Failed to connect to Paseo daemon/,
        "should not log old error message in no-daemon path",
      )

      // Verify exactly one log line was written
      const logLines = logContent
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
      assert.equal(logLines.length, 1, `expected exactly 1 log line but got ${logLines.length}`)
    } finally {
      // Restore env
      if (prevOpenCodeConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = prevOpenCodeConfigDir
      }
      if (prevXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = prevXdgConfigHome
      }
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
