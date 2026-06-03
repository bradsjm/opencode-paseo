import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import {
    createTerminalKillTool,
    createTerminalSendInputTool,
    createTerminalSendLinesTool,
} from "../lib/tools/terminal.js"

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
    return {
        isConnected: () => true,
        connect: async () => {},
        close: async () => {},
        getServerInfo: () => null,
        fetchAgents: async () => [],
        listTerminals: async () => [],
        getStatus: async () => ({}),
        getProvidersSnapshot: async () => [],
        onEvent: () => () => {},
        createTerminal: async () => ({ id: "t", name: "t" }),
        captureTerminal: async () => ({
            terminalId: "t",
            content: "",
            lineCount: 0,
            truncated: false,
        }),
        sendTerminalInput: async () => {},
        killTerminal: async () => ({ id: "t", exitCode: null }),
        respondToPermission: async (opts) => ({
            workerId: opts.workerId,
            permissionId: opts.permissionId,
            behavior: opts.behavior,
        }),
        createWorker: async () => ({
            id: "w",
            provider: "test",
            cwd: "/tmp",
            model: null,
            status: "running" as const,
            title: null,
        }),
        sendWorkerMessage: async () => {},
        waitForWorker: async () => ({
            status: "idle" as const,
            workerId: "w",
            error: null,
            lastMessage: null,
            finalSnapshot: null,
        }),
        cancelWorker: async () => {},
        killWorker: async () => {},
        archiveWorker: async (workerId) => ({
            workerId,
            archivedAt: new Date().toISOString(),
        }),
        fetchWorker: async () => null,
        updateWorker: async (opts) => ({
            workerId: opts.workerId,
            updated: true,
            metadataUpdated: opts.name !== undefined || opts.labels !== undefined,
            settingsUpdated: opts.settings !== undefined,
            errors: [],
        }),
        fetchWorkerActivity: async (opts) => ({
            workerId: opts.workerId,
            timeline: null,
        }),
        listWorktrees: async () => ({}),
        createWorktree: async () => ({}),
        archiveWorktree: async () => ({}),
        scheduleList: async () => ({}),
        scheduleInspect: async () => ({}),
        scheduleCreate: async () => ({}),
        scheduleUpdate: async () => ({}),
        schedulePause: async () => ({}),
        scheduleResume: async () => ({}),
        scheduleDelete: async () => ({}),
        scheduleRunOnce: async () => ({}),
        scheduleLogs: async () => ({}),
        ...overrides,
    }
}

// ─── Send Input Tool Tests ──────────────────────────────────────────────────

test("paseo_terminal_send_input", async (t) => {
    const logger = new Logger(false)

    await t.test("forwards exact input string unchanged to transport", async () => {
        const state = createPluginState()
        let receivedTerminalId: string | undefined
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (terminalId, input) => {
                receivedTerminalId = terminalId
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendInputTool(state, client, logger)
        const result = await toolDef.execute({ terminalId: "t1", input: "ls -la\n" })

        assert.equal(receivedTerminalId, "t1")
        assert.equal(receivedInput, "ls -la\n")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.terminalId, "t1")
        assert.equal(output.sent, 7)
    })

    await t.test("sends raw input with no escape-sequence interpretation", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendInputTool(state, client, logger)
        // Send literal backslash-n characters (not an actual newline)
        await toolDef.execute({ terminalId: "t1", input: "echo hello\\nworld" })

        assert.equal(receivedInput, "echo hello\\nworld")
    })

    await t.test("handles empty input string", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendInputTool(state, client, logger)
        const result = await toolDef.execute({ terminalId: "t1", input: "" })

        assert.equal(receivedInput, "")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.sent, 0)
    })

    await t.test("sends special characters verbatim", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendInputTool(state, client, logger)
        const specialInput = "\t\x03\x1b[A"
        await toolDef.execute({ terminalId: "t1", input: specialInput })

        assert.equal(receivedInput, specialInput)
    })
})

// ─── Send Lines Tool Tests ──────────────────────────────────────────────────

test("paseo_terminal_send_lines", async (t) => {
    const logger = new Logger(false)

    await t.test("joins lines with newlines and appends trailing newline", async () => {
        const state = createPluginState()
        let receivedTerminalId: string | undefined
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (terminalId, input) => {
                receivedTerminalId = terminalId
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendLinesTool(state, client, logger)
        const result = await toolDef.execute({
            terminalId: "t1",
            lines: ["echo hello", "echo world"],
        })

        assert.equal(receivedTerminalId, "t1")
        assert.equal(receivedInput, "echo hello\necho world\n")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.terminalId, "t1")
        assert.equal(output.lineCount, 2)
        assert.equal(output.sent, 22)
    })

    await t.test("handles single line", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendLinesTool(state, client, logger)
        const result = await toolDef.execute({ terminalId: "t1", lines: ["ls -la"] })

        assert.equal(receivedInput, "ls -la\n")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.lineCount, 1)
        assert.equal(output.sent, 7)
    })

    await t.test("preserves empty-string lines", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendLinesTool(state, client, logger)
        await toolDef.execute({ terminalId: "t1", lines: ["echo a", "", "echo b"] })

        assert.equal(receivedInput, "echo a\n\necho b\n")
    })

    await t.test("handles empty lines array", async () => {
        const state = createPluginState()
        let receivedInput: string | undefined
        const client = createMockTransport({
            sendTerminalInput: async (_terminalId, input) => {
                receivedInput = input
            },
        })

        const toolDef = createTerminalSendLinesTool(state, client, logger)
        const result = await toolDef.execute({ terminalId: "t1", lines: [] })

        assert.equal(receivedInput, "\n")
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.lineCount, 0)
        assert.equal(output.sent, 1)
    })

    await t.test("sent count matches joined string length", async () => {
        const state = createPluginState()
        const client = createMockTransport()

        const toolDef = createTerminalSendLinesTool(state, client, logger)
        const lines = ["first command", "second command", "third"]
        const result = await toolDef.execute({ terminalId: "t1", lines })

        const expectedLength = lines.join("\n").length + 1 // +1 for trailing newline
        const output = JSON.parse((result as { output: string }).output)
        assert.equal(output.sent, expectedLength)
        assert.equal(output.lineCount, 3)
    })
})

test("paseo_terminal_kill description warns to capture output first", () => {
    const logger = new Logger(false)
    const state = createPluginState()
    const client = createMockTransport()

    const toolDef = createTerminalKillTool(state, client, logger)

    assert.match(toolDef.description, /capture any important output/i)
    assert.match(toolDef.description, /paseo_terminal_capture/i)
    assert.match(toolDef.description, /buffers may not remain available afterward/i)
})
