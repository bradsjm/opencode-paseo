import test from "node:test"
import assert from "node:assert/strict"
import {
  buildDaemonConfig,
  mapServerInfo,
  mapAgentSnapshot,
  PaseoClient,
  projectTimeline,
  translateUpstreamEvent,
} from "../lib/transport/client.js"
import type { DaemonConfig } from "../lib/config.js"
import packageJson from "../package.json" with { type: "json" }

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

  await t.test("uses the package version as appVersion", () => {
    const result = buildDaemonConfig(baseConfig)
    assert.equal(result.appVersion, packageJson.version)
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
    assert.ok(a.clientId.startsWith("opencode-paseo-"))
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

test("PaseoClient.captureTerminal returns daemon-native lines and totalLines", async () => {
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  let receivedTerminalId: string | undefined
  let receivedOptions: Record<string, unknown> | undefined
  ;(client as any).daemon = {
    captureTerminal: async (terminalId: string, options: Record<string, unknown>) => {
      receivedTerminalId = terminalId
      receivedOptions = options
      return { terminalId, lines: ["line 1", "", ""], totalLines: 12 }
    },
  }

  const result = await client.captureTerminal({ terminalId: "term-1", start: 0, end: 10, stripAnsi: false })

  assert.equal(receivedTerminalId, "term-1")
  assert.deepEqual(receivedOptions, { start: 0, end: 10, stripAnsi: false })
  assert.deepEqual(result, { terminalId: "term-1", lines: ["line 1", "", ""], totalLines: 12 })
})

test("PaseoClient.createTerminal does not send command or args", async () => {
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  let receivedOptions: Record<string, unknown> | undefined
  ;(client as any).daemon = {
    createTerminal: async (
      _cwd: string,
      _name: string | undefined,
      _unused: unknown,
      options: Record<string, unknown>,
    ) => {
      receivedOptions = options
      return { terminal: { id: "t1", name: "t1", cwd: "/tmp" } }
    },
  }

  await client.createTerminal({ cwd: "/tmp", name: "term", agentId: "agent-1" })

  assert.deepEqual(receivedOptions, { agentId: "agent-1" })
})

test("projectTimeline projects compact activity summaries", async (t) => {
  await t.test("extracts compact entries and strips nested payload detail", () => {
    const result = projectTimeline(
      {
        entries: [
          {
            type: "tool",
            timestamp: "2024-01-01T00:00:00Z",
            toolName: "read",
            payload: {
              text: "Read src/index.ts and summarized the error path",
              hugeBlob: { fileContents: "very large text" },
            },
          },
        ],
        hasMore: true,
      },
      10,
    )

    assert.deepEqual(result, {
      entries: [
        {
          kind: "tool",
          timestamp: "2024-01-01T00:00:00Z",
          toolName: "read",
          summary: "Read src/index.ts and summarized the error path",
        },
      ],
      hasMore: true,
    })
  })
})

// ─── Event Translation ───────────────────────────────────────────────────────

test("translateUpstreamEvent normalizes daemon events", async (t) => {
  await t.test("agent_update upsert preserves running status", () => {
    const result = translateUpstreamEvent({
      type: "agent_update",
      agentId: "a1",
      payload: {
        kind: "upsert",
        agent: { id: "a1", status: "running" },
      },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_update")
    assert.equal(result.payload.kind, "upsert")
    if (result.type === "agent_update" && result.payload.kind === "upsert") {
      assert.equal(result.payload.agentId, "a1")
      assert.equal(result.payload.agent.status, "running")
    }
  })

  await t.test("agent_update upsert preserves error status", () => {
    const result = translateUpstreamEvent({
      type: "agent_update",
      agentId: "a1",
      payload: {
        kind: "upsert",
        agent: { id: "a1", status: "error" },
      },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_update")
    if (result.type === "agent_update" && result.payload.kind === "upsert") {
      assert.equal(result.payload.agent.status, "error")
    }
  })

  await t.test("agent_update upsert preserves closed status", () => {
    const result = translateUpstreamEvent({
      type: "agent_update",
      agentId: "a1",
      payload: {
        kind: "upsert",
        agent: { id: "a1", status: "closed" },
      },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_update")
    if (result.type === "agent_update" && result.payload.kind === "upsert") {
      assert.equal(result.payload.agent.status, "closed")
    }
  })

  await t.test("agent_update preserves permission attention without lifecycle remap", () => {
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
    assert.equal(result.type, "agent_update")
    if (result.type === "agent_update" && result.payload.kind === "upsert") {
      assert.equal(result.payload.agent.requiresAttention, true)
      assert.equal(result.payload.agent.attentionReason, "permission")
      assert.deepEqual(result.payload.agent.pendingPermissions, [{ id: "p1" }])
    }
  })

  await t.test("agent_update without agent payload is ignored", () => {
    const result = translateUpstreamEvent({
      type: "agent_update",
      agentId: "a1",
      payload: { kind: "upsert" },
    } as any)
    assert.equal(result, null)
  })

  await t.test("agent_update remove preserves remove payload", () => {
    const result = translateUpstreamEvent({
      type: "agent_update",
      agentId: "a1",
      payload: { kind: "remove", agentId: "a1" },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_update")
    assert.deepEqual(result.payload, { kind: "remove", agentId: "a1" })
  })

  await t.test("agent_deleted preserves upstream delete event", () => {
    const result = translateUpstreamEvent({
      type: "agent_deleted",
      agentId: "a1",
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_deleted")
    assert.equal(result.payload.agentId, "a1")
  })

  await t.test("terminal_stream_exit → terminal.exited", () => {
    const result = translateUpstreamEvent({
      type: "terminal_stream_exit",
      payload: { terminalId: "term-1" },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "terminal.exited")
    assert.equal(result.payload.terminalId, "term-1")
  })

  await t.test("agent_permission_request preserves upstream event name", () => {
    const result = translateUpstreamEvent({
      type: "agent_permission_request",
      agentId: "a1",
      request: { id: "p1", kind: "tool", summary: "Write file" },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_permission_request")
    assert.equal(result.payload.workerId, "a1")
    assert.equal(result.payload.permissionId, "p1")
  })

  await t.test("agent_permission_resolved preserves upstream event name", () => {
    const result = translateUpstreamEvent({
      type: "agent_permission_resolved",
      agentId: "a1",
      requestId: "p1",
      resolution: { decision: "allow" },
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_permission_resolved")
    assert.equal(result.payload.workerId, "a1")
    assert.equal(result.payload.permissionId, "p1")
  })

  await t.test("agent_stream preserves upstream event name with compact activity", () => {
    const result = translateUpstreamEvent({
      type: "agent_stream",
      agentId: "a1",
      event: { type: "turn_completed", summary: "Finished step" },
      timestamp: "2024-01-01T00:00:00Z",
    } as any)
    assert.ok(result)
    assert.equal(result.type, "agent_stream")
    assert.deepEqual(result.payload, {
      workerId: "a1",
      timestamp: "2024-01-01T00:00:00Z",
      subtype: "turn_completed",
      summary: "Finished step",
    })
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

// ─── Schedule Methods on PaseoClient ─────────────────────────────────────────

test("PaseoClient implements all schedule transport methods", () => {
  const scheduleMethods = [
    "scheduleList",
    "scheduleInspect",
    "scheduleCreate",
    "scheduleUpdate",
    "schedulePause",
    "scheduleResume",
    "scheduleDelete",
    "scheduleRunOnce",
    "scheduleLogs",
  ]
  for (const method of scheduleMethods) {
    assert.equal(
      typeof (PaseoClient.prototype as unknown as Record<string, unknown>)[method],
      "function",
      `PaseoClient.prototype.${method} should be a function`,
    )
  }
})

test("PaseoClient implements all chat transport methods", () => {
  const chatMethods = [
    "createChatRoom",
    "listChatRooms",
    "inspectChatRoom",
    "deleteChatRoom",
    "postChatMessage",
    "readChatMessages",
    "waitForChatMessages",
  ]
  for (const method of chatMethods) {
    assert.equal(
      typeof (PaseoClient.prototype as unknown as Record<string, unknown>)[method],
      "function",
      `PaseoClient.prototype.${method} should be a function`,
    )
  }
})

// ─── Worker Extension Methods on PaseoClient ─────────────────────────────────

test("PaseoClient implements extended worker transport methods", () => {
  const workerMethods = ["killWorker", "updateWorker", "fetchWorkerActivity"]
  for (const method of workerMethods) {
    assert.equal(
      typeof (PaseoClient.prototype as unknown as Record<string, unknown>)[method],
      "function",
      `PaseoClient.prototype.${method} should be a function`,
    )
  }
})

test("PaseoClient.updateWorker applies metadata and settings independently", async (t) => {
  const makeClient = (daemon: Record<string, unknown>) => {
    const client = new PaseoClient({
      host: "127.0.0.1",
      port: 1,
      connectionTimeoutMs: 100,
    })
    ;(client as any).daemon = daemon
    return client
  }

  await t.test("metadata-only update calls updateAgent", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const client = makeClient({
      updateAgent: async (workerId: string, updates: Record<string, unknown>) => calls.push([workerId, updates]),
    })

    const result = await client.updateWorker({ workerId: "w1", name: "Worker", labels: { lane: "main" } })

    assert.deepEqual(calls, [["w1", { name: "Worker", labels: { lane: "main" } }]])
    assert.deepEqual(result, {
      workerId: "w1",
      updated: true,
      metadataUpdated: true,
      settingsUpdated: false,
      errors: [],
    })
  })

  await t.test("settings-only update preserves null clear semantics and feature values", async () => {
    const calls: string[] = []
    const client = makeClient({
      setAgentMode: async (_workerId: string, modeId: string) => calls.push(`mode:${modeId}`),
      setAgentModel: async (_workerId: string, model: string | null) => calls.push(`model:${String(model)}`),
      setAgentThinkingOption: async (_workerId: string, thinkingOptionId: string | null) =>
        calls.push(`thinking:${String(thinkingOptionId)}`),
      setAgentFeature: async (_workerId: string, featureId: string, value: unknown) =>
        calls.push(`feature:${featureId}:${String(value)}`),
    })

    const result = await client.updateWorker({
      workerId: "w2",
      settings: {
        modeId: "build",
        model: null,
        thinkingOptionId: null,
        features: { web: true, level: 2 },
      },
    })

    assert.deepEqual(calls, ["mode:build", "model:null", "thinking:null", "feature:web:true", "feature:level:2"])
    assert.equal(result.updated, true)
    assert.equal(result.metadataUpdated, false)
    assert.equal(result.settingsUpdated, true)
    assert.deepEqual(result.errors, [])
  })

  await t.test("mixed failures aggregate errors while successful steps mark updated", async () => {
    const client = makeClient({
      updateAgent: async () => {
        throw new Error("metadata rejected")
      },
      setAgentMode: async () => {},
      setAgentModel: async () => {
        throw new Error("model rejected")
      },
      setAgentThinkingOption: async () => {},
      setAgentFeature: async (_workerId: string, featureId: string) => {
        if (featureId === "bad") throw new Error("feature rejected")
      },
    })

    const result = await client.updateWorker({
      workerId: "w3",
      name: "Worker",
      settings: { modeId: "build", model: "gpt", thinkingOptionId: null, features: { ok: true, bad: false } },
    })

    assert.equal(result.updated, true)
    assert.equal(result.metadataUpdated, false)
    assert.equal(result.settingsUpdated, true)
    assert.deepEqual(result.errors, [
      "metadata update failed: metadata rejected",
      "setAgentModel failed: model rejected",
      "setAgentFeature(bad) failed: feature rejected",
    ])
  })
})

// ─── createWorker Payload Assembly ───────────────────────────────────────────

test("PaseoClient.createWorker always sets background and detached to true", async () => {
  // We test the payload assembly by constructing a PaseoClient with a mocked
  // DaemonClient and verifying the arguments passed to createAgent.
  let capturedPayload: Record<string, unknown> | null = null

  // Create a minimal mock that intercepts createAgent
  const mockDaemon = {
    connect: async () => {},
    close: async () => {},
    isConnected: true,
    subscribeConnectionStatus: () => () => {},
    subscribe: () => () => {},
    getLastServerInfoMessage: () => null,
    createAgent: async (payload: Record<string, unknown>) => {
      capturedPayload = payload
      return {
        id: "w1",
        provider: "test",
        cwd: "/tmp",
        model: null,
        status: "running",
        title: null,
        labels: {},
      }
    },
  }

  // Construct PaseoClient and replace internal daemon
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  // Access private daemon field for testing
  ;(client as any).daemon = mockDaemon

  await client.createWorker({
    cwd: "/tmp",
    provider: "test",
    modeId: "build",
    model: "gpt-4",
  })

  assert.ok(capturedPayload, "createAgent should have been called")
  const payload = capturedPayload as Record<string, unknown>
  assert.equal(payload.background, true, "background must be true")
  assert.equal(payload.detached, true, "detached must be true")
  assert.equal(payload.cwd, "/tmp")
  assert.equal(payload.provider, "test")
  const config = payload.config as Record<string, unknown>
  assert.ok(config, "config should be present when model/modeId provided")
  assert.equal(config.model, "gpt-4")
  assert.equal(config.modeId, "build")
})

test("PaseoClient.createWorker sets background/detached even without model/modeId", async () => {
  let capturedPayload: Record<string, unknown> | null = null

  const mockDaemon = {
    connect: async () => {},
    close: async () => {},
    isConnected: true,
    subscribeConnectionStatus: () => () => {},
    subscribe: () => () => {},
    getLastServerInfoMessage: () => null,
    createAgent: async (payload: Record<string, unknown>) => {
      capturedPayload = payload
      return {
        id: "w2",
        provider: "test",
        cwd: "/tmp",
        model: null,
        status: "running",
        title: null,
        labels: {},
      }
    },
  }

  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  ;(client as any).daemon = mockDaemon

  await client.createWorker({ cwd: "/tmp" })

  assert.ok(capturedPayload)
  const payload = capturedPayload as Record<string, unknown>
  assert.equal(payload.background, true)
  assert.equal(payload.detached, true)
  assert.equal(payload.config, undefined, "config should be absent when no model/modeId")
})

test("PaseoClient.runWorker defaults to foreground non-detached payload", async () => {
  let capturedPayload: Record<string, unknown> | null = null

  const mockDaemon = {
    connect: async () => {},
    close: async () => {},
    isConnected: true,
    subscribeConnectionStatus: () => () => {},
    subscribe: () => () => {},
    getLastServerInfoMessage: () => null,
    createAgent: async (payload: Record<string, unknown>) => {
      capturedPayload = payload
      return {
        id: "w3",
        provider: "test",
        cwd: "/tmp",
        model: null,
        status: "running",
        title: null,
        labels: {},
      }
    },
  }

  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  ;(client as any).daemon = mockDaemon

  await client.runWorker({ cwd: "/tmp", provider: "test" })

  assert.ok(capturedPayload)
  const payload = capturedPayload as Record<string, unknown>
  assert.equal(payload.background, false)
  assert.equal(payload.detached, false)
  assert.equal(payload.cwd, "/tmp")
  assert.equal(payload.provider, "test")
})

test("PaseoClient.runWorker honors background override", async () => {
  let capturedPayload: Record<string, unknown> | null = null

  const mockDaemon = {
    connect: async () => {},
    close: async () => {},
    isConnected: true,
    subscribeConnectionStatus: () => () => {},
    subscribe: () => () => {},
    getLastServerInfoMessage: () => null,
    createAgent: async (payload: Record<string, unknown>) => {
      capturedPayload = payload
      return {
        id: "w4",
        provider: "test",
        cwd: "/tmp",
        model: null,
        status: "running",
        title: null,
        labels: {},
      }
    },
  }

  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  ;(client as any).daemon = mockDaemon

  await client.runWorker({ cwd: "/tmp", background: true })

  assert.ok(capturedPayload)
  const payload = capturedPayload as Record<string, unknown>
  assert.equal(payload.background, true)
  assert.equal(payload.detached, false)
})

test("PaseoClient.sendTerminalInput is synchronous and surfaces send errors", () => {
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  ;(client as any).daemon = {
    sendTerminalInput: () => {
      throw new Error("socket closed")
    },
  }

  assert.throws(() => client.sendTerminalInput("t1", "pwd\n"), /socket closed/)
})

test("PaseoClient maps schedule and worktree payloads to plugin-owned result shapes", async () => {
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  let archiveInput: Record<string, unknown> | null = null
  ;(client as any).daemon = {
    scheduleCreate: async () => ({
      requestId: "sched-req",
      error: null,
      schedule: {
        id: "sched-1",
        name: "Nightly",
        prompt: "Run nightly",
        cadence: { type: "every", everyMs: 1000 },
        target: { type: "agent", agentId: "a1" },
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        nextRunAt: "2024-01-01T00:01:00Z",
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: 5,
        runs: [
          {
            id: "run-1",
            scheduledFor: "2024-01-01T00:01:00Z",
            startedAt: "2024-01-01T00:01:00Z",
            endedAt: null,
            status: "running",
            agentId: "a1",
            output: null,
            error: null,
          },
        ],
      },
    }),
    scheduleLogs: async () => ({
      requestId: "logs-req",
      error: null,
      runs: [
        {
          id: "run-2",
          scheduledFor: "2024-01-02T00:01:00Z",
          startedAt: "2024-01-02T00:01:00Z",
          endedAt: "2024-01-02T00:02:00Z",
          status: "succeeded",
          agentId: "a1",
          output: "ok",
          error: null,
        },
      ],
    }),
    createPaseoWorktree: async () => ({
      requestId: "wt-req",
      error: null,
      workspace: {
        id: "ws-1",
        projectId: "proj-1",
        projectDisplayName: "Repo",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo/.worktrees/feature",
        projectKind: "git",
        workspaceKind: "worktree",
        name: "feature",
        archivingAt: null,
        status: "running",
        activityAt: null,
        scripts: [],
      },
    }),
    getPaseoWorktreeList: async () => ({
      requestId: "wt-list-req",
      error: null,
      worktrees: [
        {
          worktreePath: "/repo/.worktrees/feature",
          createdAt: "2024-01-01T00:00:00Z",
          branchName: "feature",
          head: "abc123",
        },
      ],
    }),
    archivePaseoWorktree: async (input: Record<string, unknown>) => {
      archiveInput = input
      return {
        requestId: "wt-archive-req",
        success: true,
        removedAgents: ["a1"],
        error: null,
      }
    },
  }

  const createdSchedule = await client.scheduleCreate({
    prompt: "Run nightly",
    cadence: { type: "every", everyMs: 1000 },
    target: { type: "agent", agentId: "a1" },
  })
  assert.equal(createdSchedule.requestId, "sched-req")
  assert.equal(createdSchedule.schedule?.runs[0]?.id, "run-1")

  const logs = await client.scheduleLogs({ id: "sched-1" })
  assert.equal(logs.requestId, "logs-req")
  assert.equal(logs.runs[0]?.status, "succeeded")

  const createdWorktree = await client.createWorktree({ cwd: "/repo" })
  assert.equal(createdWorktree.requestId, "wt-req")
  assert.equal(createdWorktree.workspace?.workspaceDirectory, "/repo/.worktrees/feature")

  const worktreeList = await client.listWorktrees({ cwd: "/repo" })
  assert.equal(worktreeList.requestId, "wt-list-req")
  assert.equal(worktreeList.worktrees[0]?.branchName, "feature")

  const archivedWorktree = await client.archiveWorktree({ worktreePath: "/repo/.worktrees/feature", cwd: "/repo" })
  assert.equal(archivedWorktree.requestId, "wt-archive-req")
  assert.deepEqual(archivedWorktree.removedAgents, ["a1"])
  assert.deepEqual(archiveInput, { worktreePath: "/repo/.worktrees/feature", repoRoot: "/repo" })
})

test("PaseoClient.scheduleRunOnce maps daemon timeout to async dispatch acknowledgment", async () => {
  const client = new PaseoClient({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMs: 100,
  })
  ;(client as any).daemon = {
    scheduleRunOnce: async () => {
      throw new Error("Timeout waiting for message (10000ms)")
    },
  }

  const result = await client.scheduleRunOnce({ id: "sched-1" })

  assert.equal(result.error, null)
  assert.equal(result.schedule, null)
  assert.equal(result.dispatched, true)
  assert.equal(result.async, true)
  assert.equal(result.nextStep, "paseo_schedule_logs")
  assert.match(result.warning ?? "", /Timeout waiting for message \(10000ms\)/)
})
