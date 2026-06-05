import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { pathToFileURL } from "url"
import { createOpencode } from "@opencode-ai/sdk"

function captureEnv(keys: string[]): Record<string, string | undefined> {
    return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

function restoreEnv(values: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }
}

function hasOpencodeCli(): boolean {
    const result = spawnSync("opencode", ["--version"], {
        stdio: "ignore",
    })

    return !result.error && result.status === 0
}

test("plugin loads in a real Opencode host and writes debug logs", async (t) => {
    if (!hasOpencodeCli()) {
        t.skip("requires the opencode CLI on PATH")
        return
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "opencode-paseo-host-"))
    const projectDir = join(tempRoot, "project")
    const pluginDir = join(projectDir, ".opencode", "plugins")
    const projectConfigDir = join(projectDir, ".opencode")
    const xdgConfigHome = join(tempRoot, "xdg")
    const logDir = join(xdgConfigHome, "opencode", "logs", "paseo", "daily")

    mkdirSync(pluginDir, { recursive: true })
    mkdirSync(xdgConfigHome, { recursive: true })

    const pluginSourceUrl = pathToFileURL(join(process.cwd(), "index.ts")).href
    writeFileSync(
        join(pluginDir, "opencode-paseo.ts"),
        `export { default, default as OpencodePaseoPlugin } from ${JSON.stringify(pluginSourceUrl)}\n`,
        "utf-8",
    )

    writeFileSync(
        join(projectConfigDir, "paseo.jsonc"),
        JSON.stringify(
            {
                debug: true,
                daemon: {
                    host: "127.0.0.1",
                    port: 1,
                    connectionTimeoutMs: 500,
                },
            },
            null,
            2,
        ),
        "utf-8",
    )

    const envKeys = [
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "HOME",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_PURE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    ]
    const previousEnv = captureEnv(envKeys)

    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.XDG_CACHE_HOME = join(tempRoot, "cache")
    process.env.HOME = tempRoot
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_PURE
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"

    let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined

    try {
        opencode = await createOpencode({
            port: 0,
            config: { plugin: [] },
        })

        const toolIDs = await opencode.client.tool.ids({
            query: { directory: projectDir },
        })

        // Graceful degrade: no Paseo tools registered when daemon is unreachable
        const paseoTools = (toolIDs.data ?? []).filter((id: string) => id.startsWith("paseo_"))
        assert.equal(paseoTools.length, 0, `expected no Paseo tools but found: ${paseoTools.join(", ")}`)

        assert.ok(existsSync(logDir), "expected debug log directory to be created")

        const logFiles = readdirSync(logDir).filter((name) => name.endsWith(".log"))
        assert.ok(logFiles.length > 0, "expected at least one debug log file")

        const logContent = readFileSync(join(logDir, logFiles[0]!), "utf-8")
        assert.match(logContent, /Paseo plugin not loading because Paseo daemon was not found/)
        assert.doesNotMatch(logContent, /Paseo plugin initializing/)
        assert.doesNotMatch(logContent, /Failed to connect to Paseo daemon/)
    } finally {
        opencode?.server.close()
        restoreEnv(previousEnv)
        rmSync(tempRoot, { recursive: true, force: true })
    }
})
