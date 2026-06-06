import test from "node:test"
import assert from "node:assert/strict"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { Logger } from "../lib/logger.js"
import {
  createChatCreateTool,
  createChatDeleteTool,
  createChatInspectTool,
  createChatListTool,
  createChatPostTool,
  createChatReadTool,
  createChatWaitTool,
} from "../lib/tools/chat.js"
import type { PaseoTransport } from "../lib/transport/types.js"

function createMockTransport(overrides: Partial<PaseoTransport> = {}): PaseoTransport {
  return {
    createChatRoom: async (options) => ({
      requestId: "req-create",
      room: {
        id: "room-1",
        name: options.name,
        purpose: options.purpose ?? null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messageCount: 0,
        lastMessageAt: null,
      },
      error: null,
    }),
    listChatRooms: async () => ({
      requestId: "req-list",
      rooms: [
        {
          id: "room-1",
          name: "ops",
          purpose: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          messageCount: 2,
          lastMessageAt: "2024-01-01T00:05:00Z",
        },
      ],
      error: null,
    }),
    inspectChatRoom: async (options) => ({
      requestId: "req-inspect",
      room: {
        id: "room-1",
        name: options.room,
        purpose: "coordination",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messageCount: 2,
        lastMessageAt: "2024-01-01T00:05:00Z",
      },
      error: null,
    }),
    deleteChatRoom: async (options) => ({
      requestId: "req-delete",
      room: {
        id: "room-1",
        name: options.room,
        purpose: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messageCount: 0,
        lastMessageAt: null,
      },
      error: null,
    }),
    postChatMessage: async (options) => ({
      requestId: "req-post",
      message: {
        id: "msg-1",
        roomId: options.room,
        authorAgentId: options.authorAgentId ?? "manual",
        body: options.body,
        replyToMessageId: options.replyToMessageId ?? null,
        mentionAgentIds: [],
        createdAt: "2024-01-01T00:01:00Z",
      },
      error: null,
    }),
    readChatMessages: async () => ({
      requestId: "req-read",
      messages: [],
      error: null,
    }),
    waitForChatMessages: async () => ({
      requestId: "req-wait",
      messages: [],
      timedOut: true,
      error: null,
    }),
    ...overrides,
  } as PaseoTransport
}

function mockContext(directory = "/context-dir"): ToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

test("chat tools", async (t) => {
  const logger = new Logger(false)

  await t.test("create/list/inspect/delete return daemon-backed room results", async () => {
    const client = createMockTransport()

    const created = await createChatCreateTool(client, logger).execute({ name: " ops " }, mockContext())
    const listed = await createChatListTool(client, logger).execute({}, mockContext())
    const inspected = await createChatInspectTool(client, logger).execute({ room: "ops" }, mockContext())
    const deleted = await createChatDeleteTool(client, logger).execute({ room: "ops" }, mockContext())

    assert.equal(JSON.parse((created as { output: string }).output).room.name, "ops")
    assert.equal(JSON.parse((listed as { output: string }).output).count, 1)
    assert.equal(JSON.parse((inspected as { output: string }).output).room.name, "ops")
    assert.equal(JSON.parse((deleted as { output: string }).output).room.name, "ops")
  })

  await t.test("duplicate create daemon errors remain thrown tool errors", async () => {
    const client = createMockTransport({
      createChatRoom: async () => {
        throw new Error('chat room "ops" already exists')
      },
    })

    await assert.rejects(
      () => createChatCreateTool(client, logger).execute({ name: "ops" }, mockContext()),
      /already exists/,
    )
  })

  await t.test("post defaults authorAgentId to manual when omitted", async () => {
    let receivedAuthorAgentId: string | undefined
    const client = createMockTransport({
      postChatMessage: async (options) => {
        receivedAuthorAgentId = options.authorAgentId
        return {
          requestId: "req-post",
          message: {
            id: "msg-1",
            roomId: options.room,
            authorAgentId: options.authorAgentId ?? "manual",
            body: options.body,
            replyToMessageId: null,
            mentionAgentIds: [],
            createdAt: "2024-01-01T00:01:00Z",
          },
          error: null,
        }
      },
    })

    const result = await createChatPostTool(client, logger).execute(
      {
        room: "ops",
        body: "hello",
      },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.equal(receivedAuthorAgentId, "manual")
    assert.equal(output.message.authorAgentId, "manual")
  })

  await t.test("treats null optional chat args as omitted while preserving defaults", async () => {
    let postReceived: Record<string, unknown> | undefined
    let readReceived: Record<string, unknown> | undefined
    let waitReceived: Record<string, unknown> | undefined
    const client = createMockTransport({
      postChatMessage: async (options) => {
        postReceived = options as unknown as Record<string, unknown>
        return {
          requestId: "req-post",
          message: {
            id: "msg-1",
            roomId: options.room,
            authorAgentId: options.authorAgentId ?? "manual",
            body: options.body,
            replyToMessageId: options.replyToMessageId ?? null,
            mentionAgentIds: [],
            createdAt: "2024-01-01T00:01:00Z",
          },
          error: null,
        }
      },
      readChatMessages: async (options) => {
        if ((options as { limit?: number }).limit === 1) {
          return { requestId: "req-read", messages: [], error: null }
        }
        readReceived = options as unknown as Record<string, unknown>
        return { requestId: "req-read", messages: [], error: null }
      },
      waitForChatMessages: async (options) => {
        waitReceived = options as unknown as Record<string, unknown>
        return { requestId: "req-wait", messages: [], timedOut: true, error: null }
      },
    })

    await createChatPostTool(client, logger).execute(
      { room: "ops", body: "hello", authorAgentId: null, replyToMessageId: null },
      mockContext(),
    )
    await createChatReadTool(client, logger).execute(
      { room: "ops", limit: null, since: null, authorAgentId: null },
      mockContext(),
    )
    await createChatWaitTool(client, logger).execute({ room: "ops", timeoutMs: null }, mockContext())

    assert.deepEqual(postReceived, { room: "ops", body: "hello", authorAgentId: "manual" })
    assert.deepEqual(readReceived, { room: "ops" })
    assert.deepEqual(waitReceived, { room: "ops", afterMessageId: null })
  })

  await t.test("read passes filters through and includes count", async () => {
    let received: Record<string, unknown> | undefined
    const client = createMockTransport({
      readChatMessages: async (options) => {
        received = options as unknown as Record<string, unknown>
        return {
          requestId: "req-read",
          messages: [
            {
              id: "msg-2",
              roomId: options.room,
              authorAgentId: options.authorAgentId ?? "manual",
              body: "status",
              replyToMessageId: null,
              mentionAgentIds: [],
              createdAt: "2024-01-01T00:02:00Z",
            },
          ],
          error: null,
        }
      },
    })

    const result = await createChatReadTool(client, logger).execute(
      {
        room: "ops",
        limit: 5,
        since: "2024-01-01T00:00:00Z",
        authorAgentId: "worker-1",
      },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(received, {
      room: "ops",
      limit: 5,
      since: "2024-01-01T00:00:00Z",
      authorAgentId: "worker-1",
    })
    assert.equal(output.count, 1)
  })

  await t.test("wait reads latest message first and waits after that cursor", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = createMockTransport({
      readChatMessages: async (options) => {
        calls.push({ method: "read", ...options })
        return {
          requestId: "req-read",
          messages: [
            {
              id: "msg-latest",
              roomId: options.room,
              authorAgentId: "manual",
              body: "latest",
              replyToMessageId: null,
              mentionAgentIds: [],
              createdAt: "2024-01-01T00:03:00Z",
            },
          ],
          error: null,
        }
      },
      waitForChatMessages: async (options) => {
        calls.push({ method: "wait", ...options })
        return {
          requestId: "req-wait",
          messages: [
            {
              id: "msg-new",
              roomId: options.room,
              authorAgentId: "worker-2",
              body: "new",
              replyToMessageId: null,
              mentionAgentIds: [],
              createdAt: "2024-01-01T00:04:00Z",
            },
          ],
          timedOut: false,
          error: null,
        }
      },
    })

    const result = await createChatWaitTool(client, logger).execute(
      {
        room: "ops",
        timeoutMs: 1234,
      },
      mockContext(),
    )
    const output = JSON.parse((result as { output: string }).output)

    assert.deepEqual(calls, [
      { method: "read", room: "ops", limit: 1 },
      { method: "wait", room: "ops", afterMessageId: "msg-latest", timeoutMs: 1234 },
    ])
    assert.equal(output.afterMessageId, "msg-latest")
    assert.equal(output.messages[0].id, "msg-new")
  })
})
