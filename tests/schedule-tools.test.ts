import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import { createScheduleCreateTool, createScheduleUpdateTool } from "../lib/tools/schedule.js"
import type { OpencodeClient } from "../lib/profile.js"
import type { ToolContext } from "@opencode-ai/plugin/tool"

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
    return {
        isConnected: () => true,
        connect: async () => {},
        close: async () => {},
        getServerInfo: () => null,
        fetchAgents: async () => [],
        listTerminals: async () => [],
        getStatus: async () => ({}),
        getProvidersSnapshot: async () => [{ id: "opencode", provider: "opencode" }],
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
            provider: "opencode",
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
            metadataUpdated: true,
            settingsUpdated: true,
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

function mockOpencodeClient(
    agents: Array<Record<string, unknown>> = [
        {
            name: "build",
            description: "Build agent",
            mode: "primary",
            model: { providerID: "openai", modelID: "gpt-5.4" },
        },
        {
            name: "partial",
            description: "Partial agent",
            mode: "primary",
            model: { providerID: "openai", modelID: null },
        },
    ],
): OpencodeClient {
    return {
        app: {
            agents: async () => ({ data: agents }),
        },
    } as unknown as OpencodeClient
}

function mockContext(): ToolContext {
    return {
        sessionID: "sess-1",
        messageID: "msg-1",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
    }
}

test("paseo_schedule_create", async (t) => {
    const logger = new Logger(false)

    await t.test("requires profile for new-agent target", async () => {
        const state = createPluginState()
        const client = createMockTransport()
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await assert.rejects(
            () =>
                toolDef.execute(
                    {
                        prompt: "Run nightly",
                        cadenceType: "every",
                        everyMs: 1000,
                        targetType: "new-agent",
                    },
                    mockContext(),
                ),
            /profile is required for 'new-agent' target/,
        )
    })

    await t.test("resolves profile to opencode provider and joined model", async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        const client = createMockTransport({
            scheduleCreate: async (opts) => {
                receivedOptions = opts
                return { id: "sched-1" }
            },
        })
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await toolDef.execute(
            {
                prompt: "Run nightly",
                cadenceType: "every",
                everyMs: 1000,
                targetType: "new-agent",
                profile: "build",
            },
            mockContext(),
        )

        assert.equal(receivedOptions.target.type, "new-agent")
        assert.deepEqual(receivedOptions.target.config, {
            provider: "opencode",
            cwd: "/tmp",
            model: "openai/gpt-5.4",
            modeId: "build",
        })
    })

    await t.test("omits model when profile model metadata is partial", async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        const client = createMockTransport({
            scheduleCreate: async (opts) => {
                receivedOptions = opts
                return { id: "sched-2" }
            },
        })
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await toolDef.execute(
            {
                prompt: "Run nightly",
                cadenceType: "every",
                everyMs: 1000,
                targetType: "new-agent",
                profile: "partial",
            },
            mockContext(),
        )

        assert.deepEqual(receivedOptions.target.config, {
            provider: "opencode",
            cwd: "/tmp",
            modeId: "partial",
            model: undefined,
        })
    })

    await t.test("rejects profile for non-new-agent targets", async () => {
        const state = createPluginState()
        const client = createMockTransport()
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await assert.rejects(
            () =>
                toolDef.execute(
                    {
                        prompt: "Run nightly",
                        cadenceType: "every",
                        everyMs: 1000,
                        targetType: "self",
                        agentId: "a1",
                        profile: "build",
                    },
                    mockContext(),
                ),
            /profile is only supported for target type 'new-agent'/,
        )
    })

    await t.test("errors when resolved provider is unavailable", async () => {
        const state = createPluginState()
        const client = createMockTransport({
            getProvidersSnapshot: async () => [{ id: "claude", provider: "claude" }],
        })
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await assert.rejects(
            () =>
                toolDef.execute(
                    {
                        prompt: "Run nightly",
                        cadenceType: "every",
                        everyMs: 1000,
                        targetType: "new-agent",
                        profile: "build",
                    },
                    mockContext(),
                ),
            /Provider "opencode" not found in daemon provider snapshot/,
        )
    })

    await t.test("throws clear error for unknown profile", async () => {
        const state = createPluginState()
        const client = createMockTransport()
        const opencode = mockOpencodeClient([{ name: "build", mode: "primary" }])

        const toolDef = createScheduleCreateTool(state, client, opencode, logger)
        await assert.rejects(
            () =>
                toolDef.execute(
                    {
                        prompt: "Run nightly",
                        cadenceType: "every",
                        everyMs: 1000,
                        targetType: "new-agent",
                        profile: "missing",
                    },
                    mockContext(),
                ),
            /Profile "missing" not found\. Available profiles: build/,
        )
    })
})

test("paseo_schedule_update", async (t) => {
    const logger = new Logger(false)

    await t.test("resolves profile into newAgentConfig", async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        const client = createMockTransport({
            scheduleUpdate: async (opts) => {
                receivedOptions = opts
                return { id: opts.id }
            },
        })
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
        await toolDef.execute({ id: "sched-1", profile: "build" }, mockContext())

        assert.deepEqual(receivedOptions.newAgentConfig, {
            provider: "opencode",
            model: "openai/gpt-5.4",
            modeId: "build",
            cwd: undefined,
        })
    })

    await t.test("supports cwd-only new-agent updates", async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        const client = createMockTransport({
            scheduleUpdate: async (opts) => {
                receivedOptions = opts
                return { id: opts.id }
            },
        })
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
        await toolDef.execute({ id: "sched-2", cwd: "/repo" }, mockContext())

        assert.deepEqual(receivedOptions.newAgentConfig, { cwd: "/repo" })
    })

    await t.test("resolves profile using provided cwd when profile and cwd are both set", async () => {
        const state = createPluginState()
        let receivedOptions: any = null
        let snapshotCwd: string | undefined
        let profileDirectory: string | undefined
        const client = createMockTransport({
            getProvidersSnapshot: async (cwd) => {
                snapshotCwd = cwd
                return [{ id: "opencode", provider: "opencode" }]
            },
            scheduleUpdate: async (opts) => {
                receivedOptions = opts
                return { id: opts.id }
            },
        })
        const opencode = {
            app: {
                agents: async ({ query }: { query?: { directory?: string } }) => {
                    profileDirectory = query?.directory
                    return {
                        data: [
                            {
                                name: "build",
                                description: "Build agent",
                                mode: "primary",
                                model: { providerID: "openai", modelID: "gpt-5.4" },
                            },
                        ],
                    }
                },
            },
        } as unknown as OpencodeClient

        const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
        await toolDef.execute({ id: "sched-2b", profile: "build", cwd: "/repo" }, mockContext())

        assert.equal(profileDirectory, "/repo")
        assert.equal(snapshotCwd, "/repo")
        assert.deepEqual(receivedOptions.newAgentConfig, {
            provider: "opencode",
            model: "openai/gpt-5.4",
            modeId: "build",
            cwd: "/repo",
        })
    })

    await t.test("rejects empty profile", async () => {
        const state = createPluginState()
        const client = createMockTransport()
        const opencode = mockOpencodeClient()

        const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
        await assert.rejects(
            () => toolDef.execute({ id: "sched-3", profile: "   " }, mockContext()),
            /profile must not be empty/,
        )
    })

    await t.test("throws clear error for unknown profile", async () => {
        const state = createPluginState()
        const client = createMockTransport()
        const opencode = mockOpencodeClient([{ name: "build", mode: "primary" }])

        const toolDef = createScheduleUpdateTool(state, client, opencode, logger)
        await assert.rejects(
            () => toolDef.execute({ id: "sched-4", profile: "missing" }, mockContext()),
            /Profile "missing" not found\. Available profiles: build/,
        )
    })
})
