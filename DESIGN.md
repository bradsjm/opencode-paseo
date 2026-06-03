# opencode-paseo Design

This document defines the product vision, boundaries, and engineering
principles for the plugin. It is intentionally lightweight. `PLAN.md` owns the
authoritative technical roadmap for post-Phase-1 work; this file explains what
the plugin should become and how future scope should be judged.

## North star

`opencode-paseo` should make Paseo's existing local developer capabilities
usable from OpenCode through a small, typed, OpenCode-native surface.

The target user is a developer running OpenCode locally. The plugin should help
OpenCode discover, monitor, and eventually control Paseo-managed local resources
without creating a second orchestration system inside the plugin.

A central design goal is to let OpenCode use Paseo's asynchronous terminals and
workers so LLM-driven workflows do not have to sit idle waiting on long-running
local work unless they explicitly choose to block. The plugin should make it
cheap to start work, observe progress, and come back for results later, which
improves efficiency, reduces wasted model waiting, and better matches how local
developer tasks actually run.

## Product boundaries

This plugin is:

- a thin adapter between OpenCode and the local Paseo daemon;
- a structured bridge to existing Paseo daemon requests, responses, and events;
- an OpenCode tool surface for developer workflows that are awkward to manage
  with one-off shell commands;
- a small amount of ephemeral state so OpenCode can reason about current Paseo
  resources; and
- a way to hand off long-running local work to async terminals and workers so
  OpenCode can poll, observe, or intentionally wait instead of blocking by
  default.

This plugin is not:

- a production control plane;
- a durable scheduler or recovery system;
- a replacement for the Paseo daemon, CLI, or TUI;
- a terminal emulator or streaming terminal UI;
- an independent worker-group architecture; or
- a place to invent new cross-product protocol semantics unless the existing
  OpenCode and Paseo surfaces cannot support the required workflow.

## Design principles

1. **Use existing architecture first.** Prefer the same daemon protocol, RPC
   shapes, event names, and lifecycle assumptions that the Paseo CLI already
   uses.
2. **Keep the plugin thin.** Map Paseo capabilities into OpenCode tools and
   hooks with minimal transformation. Avoid broad abstractions over one or two
   direct daemon calls.
3. **Prefer OpenCode-native primitives.** Expose capabilities as ordinary plugin
   tools, config, and event handling instead of creating a custom control plane.
4. **Make waiting optional.** Favor async terminal and worker flows where
   OpenCode can start work, keep reasoning, and only block when a workflow
   explicitly requires synchronous completion.
5. **YAGNI by default.** Do not add persistence, reconciliation, schedulers,
   reconnect machinery, or resource orchestration until a concrete developer
   workflow requires it.
6. **Hydrate instead of owning truth.** Treat the Paseo daemon as the source of
   truth. Use plugin memory as a cache/index for the current OpenCode process.
7. **Minimize maintenance under upstream change.** Keep wire-level protocol code
   in `lib/transport/`, event mapping in `lib/hooks.ts`, and assembly in
   `index.ts` so changes in Paseo or OpenCode are localized.
8. **Prefer small composable tools.** Add direct tools that mirror real Paseo
   operations before adding high-level orchestration helpers.
9. **Keep safety explicit.** Mutating actions such as sending terminal input,
   killing resources, answering permissions, stopping agents, or archiving
   worktrees should remain deliberate and visible.

## Prioritization

Future work should be prioritized when it satisfies all of these conditions:

1. the capability already exists in Paseo daemon/CLI behavior;
2. using it through shell commands is materially worse for OpenCode than using a
   typed plugin tool;
3. the tool can be implemented as a thin wrapper over existing daemon messages;
4. state can be hydrated or observed from daemon events without plugin-owned
   durable storage; and
5. the feature lets OpenCode avoid unnecessary blocking on long-running local
   work while still allowing explicit wait-oriented workflows when useful.

Work should be deprioritized when it requires new architecture, speculative
state models, custom scheduling, broad protocol translation, or production-style
availability guarantees.

## Phase framework

The phases below are planning buckets, not release promises. Later phases should
only be implemented when backed by current Paseo daemon behavior and a concrete
OpenCode workflow.

### Phase 1: visibility and inbox — implemented

Current scope:

- load layered plugin config;
- enforce a localhost-only daemon boundary;
- connect to the local Paseo daemon over WebSocket;
- hydrate current workers and terminals at startup;
- keep ephemeral in-memory state for connection, capabilities, workers,
  terminals, sessions, and inbox entries;
- translate selected daemon events into inbox entries;
- expose `paseo_status`, `paseo_inbox_read`, and `paseo_inbox_status`.

Purpose:

- give OpenCode reliable visibility into Paseo daemon state;
- reduce reliance on CLI output parsing for status checks;
- establish the minimal transport/state/event boundary needed for later tools; and
- lay the groundwork for async workflows where OpenCode can observe background
  work instead of blocking on it.

### Phase 2 candidates: terminal and permission primitives

Potential scope, only if kept thin:

- list current terminals from live daemon state;
- create a terminal using the existing Paseo terminal create request;
- capture bounded terminal output using the existing capture request;
- send explicit input/keys using the existing terminal input path;
- interrupt or kill a terminal as deliberate mutating actions; and
- answer pending agent permission requests using the existing permission response
  message.

Why this fits:

- current OpenCode workflows already need persistent dev servers, watch tests,
  REPLs, and log capture;
- the existing `paseo-terminal` skill demonstrates this workflow through CLI
  commands today;
- typed tools would reduce duplicate terminals, forgotten IDs, and unbounded log
  capture; and
- async terminal primitives would let OpenCode kick off long-running local work
  without forcing model time to be spent waiting for shell commands to finish.

What to avoid:

- binary terminal stream rendering;
- terminal promotion or automatic bash rerouting;
- complex terminal ownership beyond ephemeral OpenCode session mapping; and
- permission auto-approval.

### Phase 3 candidates: worker and worktree primitives

Potential scope, only if backed by current daemon behavior:

- spawn a Paseo worker/agent with explicit provider, model, mode, cwd, labels,
  and optional worktree settings;
- send a prompt/message to an existing worker;
- inspect worker status, labels, branch, worktree path, and recent events;
- wait for completion with bounded behavior;
- stop/archive a worker as explicit mutating actions; and
- expose enough worktree metadata to help OpenCode coordinate fan-out/fan-in
  workflows.

Why this fits:

- the existing `paseo-worktrees` skill shows that OpenCode can coordinate
  parallel agents today, but only with a large prompt/CLI protocol;
- typed tools would make worker discovery, blocking status, labels, and
  permissions more reliable;
- worktree-backed workers are one of Paseo's strongest complements to
  OpenCode's planning and review capabilities; and
- worker primitives should let OpenCode delegate parallel work and check back
  later, instead of tying up a model on tasks that can proceed asynchronously.

What to avoid:

- plugin-defined worker groups as first-class durable objects;
- automatic mergeback, branch cleanup, or PR creation;
- hidden cross-worker coordination;
- broad git abstractions unrelated to existing Paseo worktree behavior; and
- duplicate orchestration rules that belong in agent instructions or user
  judgment.

### Phase 4 candidates: lifecycle polish only if needed

Potential scope:

- small notification improvements using existing OpenCode plugin hooks;
- richer session-to-resource cleanup when resources were created by plugin
  tools; and
- additional daemon capability/status exposure when it helps tools degrade
  clearly.

These should remain polish around the thin adapter. They should not become a
durable recovery system, scheduler, or independent lifecycle manager.

## Explicit non-goals

Unless requirements change, do not build:

- relay/cloud daemon transport;
- production availability or daemon restart recovery guarantees;
- reconnect loops beyond simple startup behavior;
- plugin-local durable databases or event logs;
- terminal stream decoding/rendering;
- terminal promotion or shell rerouting;
- automatic permission approval;
- plugin-owned schedules or heartbeats;
- compaction-specific summary injection;
- worker-group/lane objects that do not exist in the daemon; or
- high-level orchestration APIs that hide direct Paseo operations without a
  demonstrated OpenCode need.

## Documentation roles

- `README.md`: concise project overview, current user-facing behavior, config,
  and constraints.
- `DESIGN.md`: product vision, boundaries, design principles, and prioritization
  guardrails.
- `PLAN.md`: authoritative technical roadmap and phase-by-phase implementation
  guidance for post-Phase-1 work.
- `SPEC.md`: deprecated for planning and retained only as a Phase 1
  implementation reference.

When behavior changes, update the smallest document that owns that information.
Do not make future plans in `README.md` sound implemented, and do not make
planning notes in this file sound like source-backed contracts.
