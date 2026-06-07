import test from "node:test"
import assert from "node:assert/strict"
import { createPluginState, insertInboxEvent } from "../lib/state/state.js"
import { readInbox, getInboxStatus } from "../lib/inbox/inbox.js"

function seedInbox(state: ReturnType<typeof createPluginState>, count: number): void {
  for (let i = 0; i < count; i++) {
    insertInboxEvent(state, {
      id: `evt-${i}`,
      kind: i % 3 === 0 ? "agent.attention" : "agent.status",
      resourceId: `w${i % 5}`,
      blocking: i % 3 === 0,
      summary: `Event ${i}`,
      read: i % 2 === 0,
      timestamp: Date.now() + i,
    })
  }
}

// ─── Inbox Read ──────────────────────────────────────────────────────────────

test("readInbox", async (t) => {
  await t.test("returns all events by default", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const result = readInbox(state)
    assert.equal(result.events.length, 10)
    assert.equal(result.hasMore, false)
  })

  await t.test("filters unread only", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const result = readInbox(state, { unreadOnly: true })
    assert.ok(result.events.every((e) => !e.read))
  })

  await t.test("filters by kind", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const result = readInbox(state, { kind: "agent.attention" })
    assert.ok(result.events.every((e) => e.kind === "agent.attention"))
  })

  await t.test("filters by resourceId", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const result = readInbox(state, { resourceId: "w0" })
    assert.ok(result.events.every((e) => e.resourceId === "w0"))
  })

  await t.test("paginates with limit", () => {
    const state = createPluginState()
    seedInbox(state, 20)
    const result = readInbox(state, { limit: 5 })
    assert.equal(result.events.length, 5)
    assert.equal(result.hasMore, true)
    assert.equal(result.nextCursor, 5)
  })

  await t.test("markRead marks returned events", () => {
    const state = createPluginState()
    seedInbox(state, 5)
    const result = readInbox(state, { unreadOnly: true, markRead: true, limit: 3 })
    for (const event of result.events) {
      assert.equal(state.inbox.get(event.id)!.read, true)
    }
  })

  await t.test("returns correct unreadCount", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const result = readInbox(state)
    const expectedUnread = Array.from(state.inbox.values()).filter((e) => !e.read).length
    assert.equal(result.unreadCount, expectedUnread)
  })

  await t.test("returns empty for no events", () => {
    const state = createPluginState()
    const result = readInbox(state)
    assert.equal(result.events.length, 0)
    assert.equal(result.hasMore, false)
    assert.equal(result.nextCursor, null)
  })
})

// ─── Inbox Status ────────────────────────────────────────────────────────────

test("getInboxStatus", async (t) => {
  await t.test("returns correct counts", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const status = getInboxStatus(state)
    const unread = Array.from(state.inbox.values()).filter((e) => !e.read)
    assert.equal(status.unreadCount, unread.length)
    assert.equal(status.blockingCount, unread.filter((e) => e.blocking).length)
  })

  await t.test("breaks down by kind", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const status = getInboxStatus(state)
    const totalByKind = Object.values(status.byKind).reduce((a, b) => a + b, 0)
    assert.equal(totalByKind, status.unreadCount)
  })

  await t.test("breaks down by resource", () => {
    const state = createPluginState()
    seedInbox(state, 10)
    const status = getInboxStatus(state)
    const totalByResource = Object.values(status.byResource).reduce((a, b) => a + b, 0)
    assert.equal(totalByResource, status.unreadCount)
  })

  await t.test("returns zeros for empty inbox", () => {
    const state = createPluginState()
    const status = getInboxStatus(state)
    assert.equal(status.unreadCount, 0)
    assert.equal(status.blockingCount, 0)
    assert.deepEqual(status.byKind, {})
    assert.deepEqual(status.byResource, {})
  })
})
