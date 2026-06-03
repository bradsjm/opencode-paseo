import test from "node:test"
import assert from "node:assert/strict"
import { PaseoClient } from "../lib/transport/client.js"

class MockWebSocket {
    sent: string[] = []
    onopen: (() => void) | null = null
    onerror: ((err: unknown) => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((msg: MessageEvent) => void) | null = null

    send(data: string) {
        this.sent.push(data)
    }

    close() {}
}

function createConnectedClient() {
    const client = new PaseoClient({ host: "127.0.0.1", port: 6767, connectionTimeoutMs: 50 })
    const ws = new MockWebSocket()

    ;(client as any).ws = ws
    ;(client as any).connected = true

    return { client, ws }
}

function respond(client: PaseoClient, message: Record<string, unknown>) {
    ;(client as any).handleMessage({ data: JSON.stringify({ type: "session_message", message }) })
}

test("PaseoClient request shaping", async (t) => {
    await t.test("fetchAgents sends subscribe options and resolves entries", async () => {
        const { client, ws } = createConnectedClient()
        const promise = client.fetchAgents({ subscribe: { subscriptionId: "sub-1" } })

        const sent = JSON.parse(ws.sent[0]!)
        assert.equal(sent.type, "session")
        assert.equal(sent.message.type, "fetch_agents_request")
        assert.deepEqual(sent.message.subscribe, { subscriptionId: "sub-1" })

        respond(client, {
            type: "fetch_agents_response",
            payload: {
                requestId: sent.message.requestId,
                entries: [{ agent: { id: "a1", status: "idle" } }],
            },
        })

        const agents = await promise
        assert.deepEqual(agents, [{ id: "a1", status: "idle" }])
    })

    await t.test("listTerminals includes optional cwd", async () => {
        const { client, ws } = createConnectedClient()
        const promise = client.listTerminals("/repo")

        const sent = JSON.parse(ws.sent[0]!)
        assert.equal(sent.message.type, "list_terminals_request")
        assert.equal(sent.message.cwd, "/repo")

        respond(client, {
            type: "list_terminals_response",
            payload: {
                requestId: sent.message.requestId,
                terminals: [{ id: "t1" }],
            },
        })

        const terminals = await promise
        assert.deepEqual(terminals, [{ id: "t1" }])
    })

    await t.test("getProvidersSnapshot sends cwd and reads entries", async () => {
        const { client, ws } = createConnectedClient()
        const promise = client.getProvidersSnapshot("/repo")

        const sent = JSON.parse(ws.sent[0]!)
        assert.equal(sent.message.type, "get_providers_snapshot_request")
        assert.equal(sent.message.cwd, "/repo")

        respond(client, {
            type: "get_providers_snapshot_response",
            payload: {
                requestId: sent.message.requestId,
                entries: [{ provider: "codex", status: "ready" }],
            },
        })

        const entries = await promise
        assert.deepEqual(entries, [{ provider: "codex", status: "ready" }])
    })

    await t.test("rpc_error rejects the pending request", async () => {
        const { client, ws } = createConnectedClient()
        const promise = client.getStatus()

        const sent = JSON.parse(ws.sent[0]!)
        respond(client, {
            type: "rpc_error",
            payload: {
                requestId: sent.message.requestId,
                error: "boom",
                code: "bad_request",
            },
        })

        await assert.rejects(promise, /boom \(code: bad_request\)/)
    })
})
