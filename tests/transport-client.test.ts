import test from "node:test"
import assert from "node:assert/strict"
import {
    buildDaemonConfig,
    mapServerInfo,
    mapAgentSnapshot,
    translateUpstreamEvent,
} from "../lib/transport/client.js"
import type { DaemonConfig } from "../lib/config.js"

// ─── Config Mapping ──────────────────────────────────────────────────────────

const baseConfig: DaemonConfig = {
    host: "127.0.0.1",
    port: 6767,
    connectionTimeoutMs: 3000,
}

test("buildDaemonConfig maps DaemonConfig to DaemonClientConfig", async (t) => {
    await t.test("builds correct URL from host and port", () => {
        const result = buildDaemonConfig(baseConfig)
        assert.equal(result.url, "ws://127.0.0.1:6767/ws")
    })

    await t.test("wraps IPv6 host in brackets", () => {
        const result = buildDaemonConfig({ ...baseConfig, host: "::1" })
        assert.equal(result.url, "ws://[::1]:6767/ws")
    })

    await t.test("sets clientType to cli", () => {
        const result = buildDaemonConfig(baseConfig)
        assert.equal(result.clientType, "cli")
    })

    await t.test("disables reconnect", () => {
        const result = buildDaemonConfig(baseConfig)
        assert.deepEqual(result.reconnect, { enabled: false })
    })

    await t.test("passes through password and timeout", () => {
        const result = buildDaemonConfig({
            ...baseConfig,
            password: "secret",
            connectionTimeoutMs: 5000,
        })
        assert.equal(result.password, "secret")
        assert.equal(result.connectTimeoutMs, 5000)
    })

    await t.test("generates unique clientId", () => {
        const a = buildDaemonConfig(baseConfig)
        const b = buildDaemonConfig(baseConfig)
        assert.notEqual(a.clientId, b.clientId)
        assert.ok(a.clientId!.startsWith("opencode-paseo-"))
    })
})

// ─── Server Info Mapping ─────────────────────────────────────────────────────

test("mapServerInfo normalizes upstream server info", async (t) => {
    await t.test("maps required fields and defaults optionals", () => {
        const result = mapServerInfo({
            serverId: "srv-1",
            hostname: null,
            version: null,
        })
        assert.equal(result.serverId, "srv-1")
        assert.equal(result.hostname, undefined)
        assert.equal(result.version, undefined)
        assert.deepEqual(result.features, {})
        assert.deepEqual(result.capabilities, {})
    })

    await t.test("preserves provided features and capabilities", () => {
        const result = mapServerInfo({
            serverId: "srv-2",
            hostname: "myhost",
            version: "0.1.89",
            features: { daemonStatusRpc: true },
            capabilities: { voice: {} },
        })
        assert.equal(result.hostname, "myhost")
        assert.equal(result.version, "0.1.89")
        assert.deepEqual(result.features, { daemonStatusRpc: true })
        assert.deepEqual(result.capabilities, { voice: {} })
    })
})

// ─── Agent Snapshot Mapping ──────────────────────────────────────────────────

test("mapAgentSnapshot maps upstream agent to AgentSummary", async (t) => {
    await t.test("maps core fields", () => {
        const result = mapAgentSnapshot({
            id: "a1",
            provider: "codex",
            cwd: "/repo",
            model: "gpt-4",
            status: "running",
            title: "My Agent",
            labels: { lane: "main" },
            requiresAttention: false,
            attentionReason: null,
            pendingPermissions: [],
            capabilities: { supportsStreaming: true },
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T01:00:00Z",
        })
        assert.equal(result.id, "a1")
        assert.equal(result.provider, "codex")
        assert.equal(result.cwd, "/repo")
        assert.equal(result.model, "gpt-4")
        assert.equal(result.status, "running")
        assert.equal(result.title, "My Agent")
        assert.deepEqual(result.labels, { lane: "main" })
    })

    await t.test("defaults missing fields", () => {
        const result = mapAgentSnapshot({ id: "a2" })
        assert.equal(result.provider, "unknown")
        assert.equal(result.cwd, "")
        assert.equal(result.model, null)
        assert.equal(result.status, "unknown")
        assert.equal(result.title, null)
        assert.deepEqual(result.labels, {})
    })

    await t.test("extracts worktreePath from labels fallback", () => {
        const result = mapAgentSnapshot({
            id: "a3",
            labels: { worktreePath: "/wt/feature", branchName: "feature-x" },
        })
        assert.equal(result.worktreePath, "/wt/feature")
        assert.equal(result.branchName, "feature-x")
    })

    await t.test("prefers direct worktreePath over labels", () => {
        const result = mapAgentSnapshot({
            id: "a4",
            worktreePath: "/wt/direct",
            labels: { worktreePath: "/wt/label" },
        })
        assert.equal(result.worktreePath, "/wt/direct")
    })
})

// ─── Event Translation ───────────────────────────────────────────────────────

test("translateUpstreamEvent normalizes daemon events", async (t) => {
    await t.test("agent_update upsert with running status → worker.started", () => {
        const result = translateUpstreamEvent({
            type: "agent_update",
            agentId: "a1",
            payload: {
                kind: "upsert",
                agent: { id: "a1", status: "running" },
            },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.started")
        assert.equal(result.payload.workerId, "a1")
    })

    await t.test("agent_update upsert with error status → worker.failed", () => {
        const result = translateUpstreamEvent({
            type: "agent_update",
            agentId: "a1",
            payload: {
                kind: "upsert",
                agent: { id: "a1", status: "error" },
            },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.failed")
    })

    await t.test("agent_update upsert with closed status → worker.finished", () => {
        const result = translateUpstreamEvent({
            type: "agent_update",
            agentId: "a1",
            payload: {
                kind: "upsert",
                agent: { id: "a1", status: "closed" },
            },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.finished")
    })

    await t.test("agent_update with permission attention → worker.blocked", () => {
        const result = translateUpstreamEvent({
            type: "agent_update",
            agentId: "a1",
            payload: {
                kind: "upsert",
                agent: {
                    id: "a1",
                    status: "running",
                    requiresAttention: true,
                    attentionReason: "permission",
                    pendingPermissions: [{ id: "p1" }],
                },
            },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.blocked")
        assert.equal(result.payload.workerId, "a1")
        assert.equal(result.payload.summary, "permission")
    })

    await t.test("agent_update remove → worker.finished", () => {
        const result = translateUpstreamEvent({
            type: "agent_update",
            agentId: "a1",
            payload: { kind: "remove", agentId: "a1" },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.finished")
        assert.equal(result.payload.workerId, "a1")
    })

    await t.test("agent_deleted → worker.finished", () => {
        const result = translateUpstreamEvent({
            type: "agent_deleted",
            agentId: "a1",
        } as any)
        assert.ok(result)
        assert.equal(result.type, "worker.finished")
        assert.equal(result.payload.workerId, "a1")
    })

    await t.test("agent_permission_request → permission.requested", () => {
        const result = translateUpstreamEvent({
            type: "agent_permission_request",
            agentId: "a1",
            request: { id: "p1", kind: "tool", summary: "Write file" },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "permission.requested")
        assert.equal(result.payload.workerId, "a1")
        assert.equal(result.payload.permissionId, "p1")
    })

    await t.test("agent_permission_resolved → permission.resolved", () => {
        const result = translateUpstreamEvent({
            type: "agent_permission_resolved",
            agentId: "a1",
            requestId: "p1",
            resolution: { decision: "allow" },
        } as any)
        assert.ok(result)
        assert.equal(result.type, "permission.resolved")
        assert.equal(result.payload.workerId, "a1")
        assert.equal(result.payload.permissionId, "p1")
    })

    await t.test("agent_stream → null (ignored)", () => {
        const result = translateUpstreamEvent({
            type: "agent_stream",
            agentId: "a1",
            event: {},
            timestamp: "2024-01-01T00:00:00Z",
        } as any)
        assert.equal(result, null)
    })

    await t.test("error → daemon.error", () => {
        const result = translateUpstreamEvent({
            type: "error",
            message: "something broke",
        } as any)
        assert.ok(result)
        assert.equal(result.type, "daemon.error")
        assert.equal(result.payload.message, "something broke")
    })

    await t.test("workspace_update → null (ignored)", () => {
        const result = translateUpstreamEvent({
            type: "workspace_update",
            workspaceId: "w1",
            payload: {},
        } as any)
        assert.equal(result, null)
    })
})
