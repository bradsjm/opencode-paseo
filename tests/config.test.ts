import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
    validateConfigTypes,
    validateLocalhostOnly,
    deepCloneConfig,
    getConfig,
} from "../lib/config.js"
import type { PluginConfig } from "../lib/config.js"

// ─── Validation Tests ────────────────────────────────────────────────────────

test("validateConfigTypes", async (t) => {
    await t.test("returns no errors for valid config", () => {
        const errors = validateConfigTypes({
            enabled: true,
            debug: false,
            daemon: { host: "127.0.0.1", port: 6767, connectionTimeoutMs: 3000 },
        })
        assert.equal(errors.length, 0)
    })

    await t.test("detects wrong type for enabled", () => {
        const errors = validateConfigTypes({ enabled: "yes" })
        assert.ok(errors.some((e) => e.key === "enabled"))
    })

    await t.test("detects wrong type for daemon.port", () => {
        const errors = validateConfigTypes({ daemon: { port: "abc" } })
        assert.ok(errors.some((e) => e.key === "daemon.port"))
    })

    await t.test("detects unknown daemon keys", () => {
        const errors = validateConfigTypes({ daemon: { unknownKey: true } })
        assert.ok(errors.some((e) => e.key === "daemon"))
    })

    await t.test("detects wrong type for notifications.enabled", () => {
        const errors = validateConfigTypes({ notifications: { enabled: 1 } })
        assert.ok(errors.some((e) => e.key === "notifications.enabled"))
    })

    await t.test("returns no errors for empty object", () => {
        const errors = validateConfigTypes({})
        assert.equal(errors.length, 0)
    })
})

// ─── Localhost Enforcement ────────────────────────────────────────────────────

test("validateLocalhostOnly", async (t) => {
    await t.test("accepts 127.0.0.1", () => {
        assert.equal(validateLocalhostOnly("127.0.0.1"), null)
    })

    await t.test("accepts localhost", () => {
        assert.equal(validateLocalhostOnly("localhost"), null)
    })

    await t.test("accepts ::1", () => {
        assert.equal(validateLocalhostOnly("::1"), null)
    })

    await t.test("rejects external host", () => {
        const result = validateLocalhostOnly("192.168.1.1")
        assert.notEqual(result, null)
        assert.equal(result!.key, "daemon.host")
    })
})

// ─── Config Loading ──────────────────────────────────────────────────────────

test("getConfig", async (t) => {
    let tempDir: string

    t.beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "paseo-test-"))
    })

    t.afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true })
    })

    await t.test("returns defaults when no config files exist", () => {
        // Use a temp dir with no config files
        process.env.OPENCODE_CONFIG_DIR = join(tempDir, "nonexistent")
        const config = getConfig({
            directory: tempDir,
            client: { tui: { showToast: () => {} } },
        })
        assert.equal(config.enabled, true)
        assert.equal(config.daemon.host, "127.0.0.1")
        assert.equal(config.daemon.port, 6767)
        assert.equal(config.output.maxInboxItems, 100)
        delete process.env.OPENCODE_CONFIG_DIR
    })

    await t.test("loads config from OPENCODE_CONFIG_DIR", () => {
        const configDir = join(tempDir, "config")
        mkdirSync(configDir, { recursive: true })
        writeFileSync(
            join(configDir, "paseo.jsonc"),
            JSON.stringify({ daemon: { port: 12345 } }),
            "utf-8",
        )

        process.env.OPENCODE_CONFIG_DIR = configDir
        const config = getConfig({
            directory: tempDir,
            client: { tui: { showToast: () => {} } },
        })
        assert.equal(config.daemon.port, 12345)
        delete process.env.OPENCODE_CONFIG_DIR
    })
})
