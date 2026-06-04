import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState } from "../lib/state/state.js"
import type { PaseoTransport } from "../lib/transport/types.js"
import { Logger } from "../lib/logger.js"
import { createWorkerLaunchQueueController } from "../lib/worker-launch/queue.js"
import type { OpencodeClient } from "../lib/profile.js"

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
}

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
        sendTerminalInput: () => {},
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
        archiveWorker: async (workerId) => ({ workerId, archivedAt: new Date().toISOString() }),
        fetchWorker: async () => null,
        updateWorker: async (opts) => ({
            workerId: opts.workerId,
            updated: true,
            metadataUpdated: false,
            settingsUpdated: false,
            errors: [],
        }),
        fetchWorkerActivity: async (opts) => ({ workerId: opts.workerId, activity: null }),
        listWorktrees: async () => ({ requestId: "req", worktrees: [], error: null }),
        createWorktree: async () => ({ requestId: "req", workspace: null, error: null }),
        archiveWorktree: async () => ({ requestId: "req", success: true, error: null }),
        scheduleList: async () => ({ requestId: "req", schedules: [], error: null }),
        scheduleInspect: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleCreate: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleUpdate: async () => ({ requestId: "req", schedule: null, error: null }),
        schedulePause: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleResume: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleDelete: async () => ({ requestId: "req", scheduleId: "sched", error: null }),
        scheduleRunOnce: async () => ({ requestId: "req", schedule: null, error: null }),
        scheduleLogs: async () => ({ requestId: "req", runs: [], error: null }),
        ...overrides,
    }
}

function createMockOpencodeClient(promptMessages: string[]): OpencodeClient {
    return {
        session: {
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                promptMessages.push(body.parts[0]?.text ?? "")
                return { data: null }
            },
        },
    } as unknown as OpencodeClient
}

test("worker launch queue controller", async (t) => {
    const logger = new Logger(false)

    await t.test("executes launches in FIFO order with max concurrency 1", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const completions = [
            createDeferred<{
                id: string
                provider: string
                cwd: string
                model: string | null
                status: "running"
                title: null
            }>(),
            createDeferred<{
                id: string
                provider: string
                cwd: string
                model: string | null
                status: "running"
                title: null
            }>(),
        ]
        const callOrder: string[] = []
        let activeCreates = 0
        let maxActiveCreates = 0
        const client = createMockTransport({
            createWorker: async (opts) => {
                const callIndex = callOrder.length
                callOrder.push(opts.labels?.["opencodePaseo.launchId"] ?? "missing")
                activeCreates += 1
                maxActiveCreates = Math.max(maxActiveCreates, activeCreates)
                const result = await completions[callIndex].promise
                activeCreates -= 1
                return result
            },
        })
        const controller = createWorkerLaunchQueueController(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
        )

        const first = controller.enqueueWorkerLaunch({
            sessionId: "sess-1",
            projectRoot: "/project",
            profile: "build",
            cwd: "/project",
            provider: "opencode",
            model: "openai/gpt-5.4",
            modeId: "build",
        })
        const second = controller.enqueueWorkerLaunch({
            sessionId: "sess-1",
            projectRoot: "/project",
            profile: "review",
            cwd: "/project",
            provider: "opencode",
            model: "anthropic/claude-3",
            modeId: "review",
        })

        const drainPromise = controller.drainWorkerLaunchQueue()
        await flushAsyncWork()

        assert.equal(first.position, 1)
        assert.equal(second.position, 2)
        assert.equal(callOrder.length, 1)
        assert.equal(callOrder[0], first.launchId)
        assert.equal(state.activeWorkerLaunchId, first.launchId)

        completions[0].resolve({
            id: "w1",
            provider: "opencode",
            cwd: "/project",
            model: "openai/gpt-5.4",
            status: "running",
            title: null,
        })
        await flushAsyncWork()

        assert.equal(callOrder.length, 2)
        assert.equal(callOrder[1], second.launchId)
        assert.equal(state.activeWorkerLaunchId, second.launchId)

        completions[1].resolve({
            id: "w2",
            provider: "opencode",
            cwd: "/project",
            model: "anthropic/claude-3",
            status: "running",
            title: null,
        })
        await drainPromise

        assert.equal(maxActiveCreates, 1)
        assert.equal(state.activeWorkerLaunchId, null)
        assert.equal(state.workerLaunchQueue.length, 0)
        assert.equal(promptMessages.length, 2)
    })

    await t.test(
        "continues to next launch after failure and binds successful worker to session state",
        async () => {
            const state = createPluginState()
            const promptMessages: string[] = []
            const first = createDeferred<never>()
            const second = createDeferred<{
                id: string
                provider: string
                cwd: string
                model: string | null
                status: "running"
                title: null
            }>()
            let callIndex = 0
            const client = createMockTransport({
                createWorker: async () => {
                    callIndex += 1
                    return callIndex === 1 ? first.promise : second.promise
                },
            })
            const controller = createWorkerLaunchQueueController(
                state,
                client,
                createMockOpencodeClient(promptMessages),
                logger,
            )

            const failedReceipt = controller.enqueueWorkerLaunch({
                sessionId: "sess-1",
                projectRoot: "/project",
                profile: "build",
                cwd: "/project",
                provider: "opencode",
                modeId: "build",
            })
            const successReceipt = controller.enqueueWorkerLaunch({
                sessionId: "sess-1",
                projectRoot: "/project",
                profile: "review",
                cwd: "/project",
                provider: "opencode",
                modeId: "review",
            })

            const drainPromise = controller.drainWorkerLaunchQueue()
            await flushAsyncWork()
            first.reject(new Error("launch failed"))
            await flushAsyncWork()

            second.resolve({
                id: "w-success",
                provider: "opencode",
                cwd: "/project",
                model: null,
                status: "running",
                title: null,
            })
            await drainPromise

            const failedStatus = controller.getWorkerLaunchStatus(failedReceipt.launchId)
            const successStatus = controller.getWorkerLaunchStatus(successReceipt.launchId)
            assert.equal(failedStatus.status, "failed")
            assert.match(failedStatus.error ?? "", /launch failed/)
            assert.equal(successStatus.status, "created")
            assert.equal(successStatus.workerId, "w-success")
            assert.ok(state.workers.has("w-success"))
            assert.ok(state.sessions.get("sess-1")?.createdWorkerIds.has("w-success"))
            assert.deepEqual(state.workers.get("w-success")?.labels, [])
            assert.equal(promptMessages.length, 2)
            assert.match(promptMessages[0], new RegExp(failedReceipt.launchId))
            assert.match(promptMessages[1], /w-success/)
        },
    )

    await t.test(
        "fetchWorker failure does not flip created launch to failed and success nudge includes launchId and workerId",
        async () => {
            const state = createPluginState()
            const promptMessages: string[] = []
            const client = createMockTransport({
                createWorker: async () => ({
                    id: "w-enriched",
                    provider: "opencode",
                    cwd: "/project",
                    model: null,
                    status: "running" as const,
                    title: null,
                }),
                fetchWorker: async () => {
                    throw new Error("fetch failed")
                },
            })
            const controller = createWorkerLaunchQueueController(
                state,
                client,
                createMockOpencodeClient(promptMessages),
                logger,
            )

            const receipt = controller.enqueueWorkerLaunch({
                sessionId: "sess-1",
                projectRoot: "/project",
                profile: "build",
                cwd: "/project",
                provider: "opencode",
                modeId: "build",
            })

            await controller.drainWorkerLaunchQueue()
            await flushAsyncWork()

            const status = controller.getWorkerLaunchStatus(receipt.launchId)
            assert.equal(status.status, "created")
            assert.equal(status.workerId, "w-enriched")
            assert.equal(promptMessages.length, 1)
            assert.match(promptMessages[0], new RegExp(receipt.launchId))
            assert.match(promptMessages[0], /w-enriched/)
        },
    )

    await t.test("failed launch nudge includes launchId and error", async () => {
        const state = createPluginState()
        const promptMessages: string[] = []
        const client = createMockTransport({
            createWorker: async () => {
                throw new Error("daemon unavailable")
            },
        })
        const controller = createWorkerLaunchQueueController(
            state,
            client,
            createMockOpencodeClient(promptMessages),
            logger,
        )

        const receipt = controller.enqueueWorkerLaunch({
            sessionId: "sess-1",
            projectRoot: "/project",
            profile: "build",
            cwd: "/project",
            provider: "opencode",
            modeId: "build",
        })

        await controller.drainWorkerLaunchQueue()
        await flushAsyncWork()

        const status = controller.getWorkerLaunchStatus(receipt.launchId)
        assert.equal(status.status, "failed")
        assert.equal(promptMessages.length, 1)
        assert.match(promptMessages[0], new RegExp(receipt.launchId))
        assert.match(promptMessages[0], /daemon unavailable/)
    })
})
