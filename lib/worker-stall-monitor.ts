import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import { markUnreadStallEventsRead } from "./state/state.js"
import type { PluginState, WorkerSummary } from "./state/types.js"
import type { DaemonEvent, WorkerEventPayload } from "./transport/types.js"

interface WorkerMonitorEntry {
  lastActivityAtMs: number
  lastActivityAtIso: string | null
  lastSeenUpdatedAt: string | null
  stallActive: boolean
}

interface WorkerStallMonitor {
  seedFromWorkers(): void
  observeEvent(event: DaemonEvent): void
  start(): void
  stop(): void
}

function parseTimestampMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : null
}

function pickSeedTimestamp(worker: WorkerSummary, nowMs: number): { ms: number; iso: string | null } {
  const updatedMs = parseTimestampMs(worker.updatedAt)
  if (updatedMs !== null) return { ms: updatedMs, iso: worker.updatedAt ?? null }

  const createdMs = parseTimestampMs(worker.createdAt)
  if (createdMs !== null) return { ms: createdMs, iso: worker.createdAt ?? null }

  return { ms: nowMs, iso: null }
}

function isWorkerEligible(worker: WorkerSummary | undefined): worker is WorkerSummary {
  return Boolean(
    worker &&
    worker.status === "running" &&
    worker.rawStatus !== "idle" &&
    worker.pendingPermissionIds.length === 0 &&
    !worker.requiresAttention,
  )
}

function getSnapshotUpdatedAt(payload: WorkerEventPayload): string | null {
  const agent = payload.agent as Record<string, unknown> | undefined
  return typeof agent?.updatedAt === "string" ? agent.updatedAt : null
}

function buildStalledSummary(workerId: string, payload: Record<string, unknown>): string {
  const rawStatus = typeof payload.rawStatus === "string" ? payload.rawStatus : "unknown"
  return `Worker ${workerId} appears stalled while ${rawStatus}`
}

export function createWorkerStallMonitor(
  state: PluginState,
  logger: Logger,
  config: PluginConfig,
  emitEvent: (event: DaemonEvent) => void,
): WorkerStallMonitor {
  const entries = new Map<string, WorkerMonitorEntry>()
  const sweepIntervalMs = Math.max(10_000, Math.min(30_000, config.notifications.stalledThresholdMs / 2))
  let intervalHandle: ReturnType<typeof setInterval> | null = null

  const clearStall = (workerId: string, reason: string): void => {
    const entry = entries.get(workerId)
    if (!entry?.stallActive) return
    entry.stallActive = false
    markUnreadStallEventsRead(state, workerId)
    logger.debug("Worker stall cleared", { workerId, reason })
  }

  const ensureEntry = (workerId: string, worker?: WorkerSummary): WorkerMonitorEntry => {
    const existing = entries.get(workerId)
    if (existing) return existing

    const nowMs = Date.now()
    const knownWorker = worker ?? state.workers.get(workerId)
    const seeded = knownWorker ? pickSeedTimestamp(knownWorker, nowMs) : { ms: nowMs, iso: null }
    const created: WorkerMonitorEntry = {
      lastActivityAtMs: seeded.ms,
      lastActivityAtIso: seeded.iso,
      lastSeenUpdatedAt: knownWorker?.updatedAt ?? null,
      stallActive: false,
    }
    entries.set(workerId, created)
    return created
  }

  const recordActivity = (workerId: string, timestamp: string | undefined, reason: string): void => {
    const worker = state.workers.get(workerId)
    const entry = ensureEntry(workerId, worker)
    const parsedMs = parseTimestampMs(timestamp)
    const nextMs = parsedMs ?? Date.now()
    const nextIso = parsedMs !== null ? (timestamp ?? null) : entry.lastActivityAtIso

    if (nextMs > entry.lastActivityAtMs) {
      entry.lastActivityAtMs = nextMs
      entry.lastActivityAtIso = nextIso
    }

    if (timestamp && (!entry.lastSeenUpdatedAt || timestamp > entry.lastSeenUpdatedAt)) {
      entry.lastSeenUpdatedAt = timestamp
    }

    clearStall(workerId, reason)
  }

  const observeSnapshotUpdate = (payload: WorkerEventPayload, reason: string): void => {
    const updatedAt = getSnapshotUpdatedAt(payload)
    if (!updatedAt) return

    const entry = ensureEntry(payload.workerId)
    if (!entry.lastSeenUpdatedAt || updatedAt > entry.lastSeenUpdatedAt) {
      entry.lastSeenUpdatedAt = updatedAt
      recordActivity(payload.workerId, updatedAt, reason)
    }
  }

  const clearIfIneligible = (workerId: string, reason: string): void => {
    const worker = state.workers.get(workerId)
    if (!isWorkerEligible(worker)) {
      clearStall(workerId, reason)
    }
    if (!worker) {
      entries.delete(workerId)
    }
  }

  const sweep = (): void => {
    const nowMs = Date.now()
    for (const worker of state.workers.values()) {
      const workerId = worker.id
      if (!isWorkerEligible(worker)) {
        clearIfIneligible(workerId, "ineligible")
        continue
      }

      const entry = ensureEntry(workerId, worker)
      if (entry.stallActive) continue

      if (nowMs - entry.lastActivityAtMs < config.notifications.stalledThresholdMs) {
        continue
      }

      entry.stallActive = true
      const detectedAt = new Date(nowMs).toISOString()
      emitEvent({
        type: "worker.stalled",
        payload: {
          workerId,
          thresholdMs: config.notifications.stalledThresholdMs,
          lastActivityAt: entry.lastActivityAtIso,
          detectedAt,
          detector: "plugin-heuristic",
          status: worker.status,
          rawStatus: worker.rawStatus ?? null,
          summary: buildStalledSummary(workerId, { rawStatus: worker.rawStatus }),
        },
      })
    }
  }

  function observeActivityEvent(payload: Extract<DaemonEvent, { type: "worker.activity" }>["payload"]): void {
    recordActivity(payload.workerId, payload.timestamp, "activity")
  }

  function observeWorkerStartedEvent(payload: Extract<DaemonEvent, { type: "worker.started" }>["payload"]): void {
    observeSnapshotUpdate(payload, "snapshot-update")
    clearIfIneligible(payload.workerId, "started-state-change")
  }

  function observeWorkerBlockedEvent(payload: Extract<DaemonEvent, { type: "worker.blocked" }>["payload"]): void {
    observeSnapshotUpdate(payload, "blocked-update")
    clearIfIneligible(payload.workerId, "blocked")
  }

  function observeTerminalWorkerEvent(
    payload: Extract<DaemonEvent, { type: "worker.finished" | "worker.failed" }>["payload"],
    reason: "worker.finished" | "worker.failed",
  ): void {
    observeSnapshotUpdate(payload, "terminal-update")
    clearIfIneligible(payload.workerId, reason)
  }

  function observePermissionEvent(workerId: string, reason: "permission.requested" | "permission.resolved"): void {
    clearIfIneligible(workerId, reason)
  }

  function observeWorkerMonitorEvent(event: DaemonEvent): boolean {
    if (event.type === "worker.activity") observeActivityEvent(event.payload)
    else if (event.type === "worker.started") observeWorkerStartedEvent(event.payload)
    else if (event.type === "worker.blocked") observeWorkerBlockedEvent(event.payload)
    else if (event.type === "worker.finished" || event.type === "worker.failed")
      observeTerminalWorkerEvent(event.payload, event.type)
    else return false
    return true
  }

  function observePermissionMonitorEvent(event: DaemonEvent): boolean {
    if (event.type !== "permission.requested" && event.type !== "permission.resolved") return false
    observePermissionEvent(event.payload.workerId, event.type)
    return true
  }

  return {
    seedFromWorkers() {
      const nowMs = Date.now()
      for (const worker of state.workers.values()) {
        const seeded = pickSeedTimestamp(worker, nowMs)
        entries.set(worker.id, {
          lastActivityAtMs: seeded.ms,
          lastActivityAtIso: seeded.iso,
          lastSeenUpdatedAt: worker.updatedAt ?? null,
          stallActive: false,
        })
      }
    },
    observeEvent(event) {
      if (observeWorkerMonitorEvent(event)) return
      if (observePermissionMonitorEvent(event)) return
      if (isIgnoredMonitorEvent(event)) return
    },
    start() {
      if (intervalHandle) return
      intervalHandle = setInterval(sweep, sweepIntervalMs)
    },
    stop() {
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      entries.clear()
    },
  }

  function isIgnoredMonitorEvent(
    event: DaemonEvent,
  ): event is Extract<
    DaemonEvent,
    { type: "worker.stalled" | "terminal.exited" | "daemon.connected" | "daemon.disconnected" | "daemon.error" }
  > {
    switch (event.type) {
      case "worker.stalled":
      case "terminal.exited":
      case "daemon.connected":
      case "daemon.disconnected":
      case "daemon.error":
        return true
      default:
        return false
    }
  }
}
