# opencode-paseo Plan

Status: authoritative technical plan for post-Phase-1 work  
Audience: maintainers, contributors, and implementation agents  
Validated against: repository source, OpenCode `1.15.13` plugin/sdk types, Paseo `0.1.89` client/protocol/CLI source, and read-only live daemon responses observed on 2026-06-03

If this file disagrees with checked-in code, current package types, or live daemon
responses, update this file before implementing new behavior.

## 1. Authority and scope

`PLAN.md` owns the technical roadmap for everything after the implemented Phase 1
baseline.

- `README.md` owns the concise user-facing description of the current plugin.
- `DESIGN.md` owns product vision, boundaries, and design principles.
- `PLAN.md` owns the source-grounded implementation plan for future phases.

This document is intentionally technical. It exists so future implementation can
follow current OpenCode and Paseo surfaces without re-inventing protocol
semantics or expanding beyond the plugin's thin-adapter mission.

## 2. Current implemented baseline

Phase 1 is complete. The checked-in code currently does all of the following:

1. loads layered plugin configuration from global, config-dir, and project files;
2. enforces a localhost-only daemon boundary in config validation;
3. connects to the local Paseo daemon over WebSocket during plugin startup;
4. hydrates worker and terminal snapshots at startup;
5. keeps ephemeral in-memory connection, capability, worker, terminal, session,
   and inbox state;
6. seeds unread blocking inbox events for workers already requiring attention;
7. translates selected live daemon events into inbox events; and
8. registers exactly three tools:
    - `paseo_status`
    - `paseo_inbox_read`
    - `paseo_inbox_status`

Current assembly and ownership boundaries must remain intact:

- `index.ts` remains the assembly layer: config -> logger -> state -> client ->
  hydrate -> event wiring -> tool registration.
- `lib/transport/` remains the daemon boundary.
- `lib/hooks.ts` remains the daemon-event to inbox-event translation layer.
- `lib/state/` remains the plugin's ephemeral cache/index.
- `lib/tools/` remains the OpenCode tool surface.

Current Phase 1 constraints that remain in force unless requirements change:

- no reconnect loop or daemon restart recovery;
- no durable plugin-local persistence;
- no terminal streaming UI or binary terminal rendering;
- no terminal promotion or shell rerouting;
- no automatic permission approval;
- no worker-group or lane abstractions;
- no schedule or heartbeat feature work; and
- no relay/cloud transport behavior in the plugin.

## 3. Planning constraints for all future phases

Every future phase in this file must preserve these constraints.

### 3.1 Keep the plugin thin

- Prefer direct wrappers over existing Paseo daemon methods.
- Prefer ordinary OpenCode tools and hooks over custom orchestration layers.
- Do not introduce plugin-owned workflow objects when Paseo already owns the
  resource model.

### 3.2 Keep the daemon as source of truth

- Hydrate from daemon snapshots.
- Refresh from daemon events or explicit daemon calls.
- Treat plugin state as ephemeral cache, not durable truth.

### 3.3 Keep safety explicit

- Mutating actions must remain explicit tools.
- Do not hide terminal input, terminal kill, permission responses, worker stop,
  worker archive, or worktree archive behind automatic lifecycle behavior.

### 3.4 Keep current product boundaries

Even if upstream Paseo supports them today, this plan does not include:

- terminal directory subscriptions or binary terminal stream consumption;
- schedules, heartbeats, loops, or chat-room features;
- reconnect loops just because the upstream client can do them;
- relay or cloud transport;
- durable recovery, event logs, or resume databases; or
- compaction-specific summary injection.

## 4. Verified external grounding

This plan is grounded in the package versions and live daemon behavior available
today, not in speculative future APIs.

### 4.1 OpenCode plugin surface confirmed today

From `@opencode-ai/plugin` and `@opencode-ai/sdk` `1.15.13`:

- the current plugin surface remains `tool`, `event`, and `config` hooks;
- tool execution context includes `sessionID`, `messageID`, `agent`,
  `directory`, `worktree`, `abort`, `metadata(...)`, and `ask(...)`;
- tool results are strings or `{ title, output, metadata?, attachments? }`;
- useful future hooks that exist today include `dispose`, `permission.ask`,
  `tool.execute.before`, `tool.execute.after`, and `shell.env`;
- `experimental.session.compacting` exists but remains explicitly out of scope
  for this plan.

Implementation consequence: future phases can correlate created Paseo resources
with OpenCode `sessionID` and session working directories without inventing a
separate session model.

### 4.2 Paseo client surface confirmed today

From `@getpaseo/client` `0.1.89`:

- prefer the public `DaemonClient` export from `@getpaseo/client`;
- do not build future work on `createPaseoClient()` because its public
  high-level surface does not expose the raw terminal/worktree/schedule methods
  this plugin needs;
- `DaemonClientConfig` supports `url`, `clientId`, `clientType`, `appVersion`,
  `password`, `connectTimeoutMs`, and optional `reconnect` settings;
- the plugin must set `clientType: "cli"` and `reconnect.enabled: false` to
  preserve current product behavior.

Verified upstream `DaemonClient` methods relevant to this plugin's future phases:

- current baseline: `fetchAgents()`, `listTerminals()`, `getProvidersSnapshot()`,
  `getDaemonStatus()`, typed event subscription;
- terminals: `createTerminal()`, `captureTerminal()`, `sendTerminalInput()`,
  `killTerminal()`;
- permissions: `respondToPermission()`, `respondToPermissionAndWait()`;
- workers: `createAgent()`, `sendAgentMessage()`, `waitForFinish()`,
  `cancelAgent()`, `archiveAgent()`;
- worktrees: `getPaseoWorktreeList()`, `createPaseoWorktree()`,
  `archivePaseoWorktree()`.

### 4.3 Live daemon observations used to validate assumptions

Read-only live daemon queries on 2026-06-03 confirmed all of the following:

- daemon status reports Paseo `0.1.89` and exposes `serverId`, `version`,
  `listen`, `relay`, and provider availability;
- provider snapshot responses already include provider readiness plus concrete
  model and mode metadata;
- live agent snapshots include fields such as `id`, `provider`, `cwd`, `model`,
  `currentModeId`, `status`, `title`, `labels`, `pendingPermissions`,
  `persistence`, and `runtimeInfo`;
- `listTerminals(cwd)` returns `{ cwd, terminals, requestId }`;
- `getPaseoWorktreeList({ cwd })` returns `{ worktrees, error, requestId }`;
- the current CLI `paseo worktree ls` path can fail without `cwd` or `repoRoot`,
  so the plugin must call the daemon method with an explicit directory instead
  of copying CLI UX assumptions.

Implementation consequence: future worker and worktree tools should trust direct
daemon/client responses over CLI output-shaping behavior.

## 5. Cross-cutting architecture decision: adopt `@getpaseo/client`

Future work must stop extending the repository's handwritten protocol client as
the long-term transport implementation.

### 5.1 Direction

Adopt `@getpaseo/client` `DaemonClient` as the plugin's transport foundation and
reduce local transport code to a small adapter layer.

This applies to existing Phase 1 behavior as well as future phases.

### 5.2 What stays local

Even after migration, keep a local transport adapter owned by this repository so
that plugin code does not depend directly on the full upstream client surface.

That local adapter should own only:

- translation from plugin config to `DaemonClientConfig`;
- the small method surface the plugin actually uses;
- any plugin-specific event normalization still needed by `lib/hooks.ts`; and
- clean shutdown/disposal integration with OpenCode hooks.

### 5.3 What must be removed or collapsed during migration

During the migration, remove repository-owned protocol duplication wherever the
upstream client now owns the source of truth.

That includes:

- handwritten request/response correlation logic in `lib/transport/client.ts`;
- handwritten protocol request/response/event shapes in
  `lib/transport/types.ts` that duplicate upstream client/protocol types; and
- assumptions in local types that do not match current upstream payloads.

Keep plugin-specific types only when they describe plugin state or plugin event
semantics rather than daemon wire contracts.

### 5.4 Migration guardrails

Adopting `DaemonClient` must not change these behaviors:

- localhost-only plugin connection policy remains enforced in config validation;
- reconnect remains disabled by plugin policy even though the upstream client can
  reconnect;
- the plugin still loads successfully when daemon connection fails at startup;
- `paseo_status`, `paseo_inbox_read`, and `paseo_inbox_status` retain their
  existing public semantics unless this plan explicitly changes them.

## 6. Phase 2: transport migration, terminal primitives, permission response

Phase 2 is the first post-Phase-1 implementation phase.

### 6.1 Objective

Replace the handwritten transport with an upstream-client-backed adapter, then
add the first deliberate mutating tools that enable persistent local developer
workflows without terminal streaming.

### 6.2 Required order

Implement Phase 2 in this order:

1. replace the current transport implementation with a `DaemonClient` adapter;
2. restore full Phase 1 behavior on the new transport;
3. add terminal read/create/input/kill primitives; and
4. add explicit permission response.

Do not build new Phase 2 tools on top of the old handwritten client.

### 6.3 Transport migration requirements

The new adapter should preserve the existing plugin structure:

- `index.ts` still instantiates a local transport wrapper, not raw upstream
  client code directly;
- `lib/hydration/hydrate.ts` still owns startup hydration;
- `lib/hooks.ts` still owns daemon-event to inbox-event translation;
- `lib/state/` still owns ephemeral state.

Adapter requirements:

- construct `DaemonClient` with `clientType: "cli"`;
- generate and pass a non-empty `clientId` for every client instance;
- preserve an explicit `appVersion` during migration instead of relying on an
  upstream default; do not change the Phase 1 hello/version behavior without
  re-validating against a live daemon;
- derive `url` from the existing validated daemon config (`ws://<host>:<port>/ws`);
- pass through `password` and `connectTimeoutMs`;
- set `reconnect.enabled: false`;
- expose at least the Phase 1 methods plus the new Phase 2 methods;
- expose clean shutdown so a later `dispose` hook can call `close()`.

### 6.4 Terminal tool surface

Phase 2 should add the following tool family:

| Tool                        | Upstream method                                             | Notes                                                                              |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `paseo_terminal_list`       | `listTerminals(cwd?)`                                       | read-only snapshot tool                                                            |
| `paseo_terminal_create`     | `createTerminal(cwd, name?, requestId?, options?)`          | start with `cwd` + optional `name`; keep optional `command`/`args` thin if exposed |
| `paseo_terminal_capture`    | `captureTerminal(terminalId, { start?, end?, stripAnsi? })` | bounded capture only                                                               |
| `paseo_terminal_send_input` | `sendTerminalInput(terminalId, message)`                    | explicit input only                                                                |
| `paseo_terminal_kill`       | `killTerminal(terminalId)`                                  | explicit mutating action                                                           |

Tool design rules:

- keep terminal output capture bounded and explicit;
- do not implement streaming output or terminal subscriptions;
- do not invent terminal ownership rules beyond OpenCode session mapping for
  resources created by plugin tools;
- use tool context `directory` as the default `cwd` when callers do not provide
  one explicitly.

### 6.5 Permission response surface

Phase 2 should add:

| Tool                       | Upstream method                   | Notes                                                            |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `paseo_permission_respond` | `respondToPermissionAndWait(...)` | prefer deterministic tool results over CLI-style fire-and-forget |

Tool rules:

- the tool must remain agent-scoped and permission-id-scoped;
- prefer `respondToPermissionAndWait()` so tool output can reflect the actual
  resolution instead of merely reporting that a message was sent;
- update inbox/read state to match the resulting resolution event rather than
  inventing separate plugin-only permission state.

### 6.6 State and hook changes required in Phase 2

- populate `SessionMapping.createdTerminalIds` for terminals created by plugin
  tools;
- keep terminal state snapshot-based; do not add output buffers or stream caches;
- keep permission metadata tied to inbox events and worker state rather than a
  new top-level permission store;
- remove or update any event kinds and metadata assumptions that are not actually
  emitted by the migrated transport.

### 6.7 Phase 2 acceptance criteria

Phase 2 is complete only when all of the following are true:

- the plugin no longer depends on handwritten daemon request/response code for
  the migrated surface;
- all current Phase 1 tools still work on the new transport;
- terminal create/capture/input/kill tools work against a live daemon;
- permission response works against a live daemon;
- no binary terminal streaming or reconnect behavior was added; and
- tests cover both the transport migration and the new tool behavior.

## 7. Phase 3: worker and worktree primitives

Phase 3 adds explicit worker control and the minimum worktree surface needed to
support the workflows described in `README.md`.

### 7.1 Objective

Make existing Paseo worker and worktree capabilities usable from OpenCode
through explicit, typed tools without introducing plugin-owned orchestration
objects.

### 7.2 Worker tool surface

Phase 3 should add the following worker tool family:

| Tool                   | Upstream method                              | Notes                                                |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `paseo_worker_list`    | `fetchAgents(...)` or hydrated state refresh | must expose enough detail to reuse existing workers  |
| `paseo_worker_create`  | `createAgent(options)`                       | explicit provider/model/mode/cwd inputs              |
| `paseo_worker_send`    | `sendAgentMessage(agentId, text, options?)`  | explicit worker reuse                                |
| `paseo_worker_wait`    | `waitForFinish(agentId, timeout?)`           | bounded wait only                                    |
| `paseo_worker_cancel`  | `cancelAgent(agentId)`                       | explicit mutating action                             |
| `paseo_worker_archive` | `archiveAgent(agentId)`                      | explicit mutating action                             |
| `paseo_worker_inspect` | fresh snapshot or enriched hydrated state    | expose status, labels, permissions, runtime identity |

### 7.3 Worker implementation rules

- do not hide worker creation behind higher-level group or lane abstractions;
- use provider/model/mode IDs that exist in current provider snapshots;
- treat worker creation as a first-class daemon call, not a shell wrapper;
- preserve the distinction between worker creation, worker prompting, waiting,
  and archival as separate tool operations;
- keep waits bounded and explicit.

Important upstream nuance: `createAgent()` is not a simple direct
`<type>.response` workflow in the daemon protocol. The plan must follow the
upstream client behavior instead of re-creating the earlier handwritten
correlation model.

### 7.4 Worker state model changes

Before or during Phase 3, update worker state to match the data needed by the
new tools.

Minimum additions beyond the current Phase 1 summary shape:

- model identity;
- current mode identity;
- current permission/request metadata;
- persistence/runtime identity needed to correlate existing Paseo workers with
  OpenCode-facing state.

Do not assume `worktreePath` and `branchName` are always present as top-level
agent snapshot fields. When worktree association matters, derive it from current
worktree RPCs or other confirmed runtime metadata instead of guessing.

### 7.5 Worktree tool surface

Only add worktree tools that directly support worker workflows.

Recommended minimum set:

| Tool                     | Upstream method                             | Notes                                     |
| ------------------------ | ------------------------------------------- | ----------------------------------------- |
| `paseo_worktree_list`    | `getPaseoWorktreeList({ cwd or repoRoot })` | always send an explicit directory         |
| `paseo_worktree_create`  | `createPaseoWorktree(input)`                | keep inputs close to daemon request shape |
| `paseo_worktree_archive` | `archivePaseoWorktree(input)`               | explicit mutating action                  |

Rules:

- require explicit `cwd` or repo root context when listing/managing worktrees;
- do not invent worker-group or lane objects;
- do not add automatic mergeback, branch cleanup, or PR creation;
- keep worktree tools as direct Paseo wrappers, not a new git abstraction layer.

### 7.6 Phase 3 acceptance criteria

Phase 3 is complete only when all of the following are true:

- OpenCode can create, inspect, message, wait on, cancel, and archive Paseo
  workers through typed tools;
- worker tools use provider/model/mode values grounded in current provider
  snapshot data;
- worktree tools, if added, operate through explicit daemon RPCs with directory
  context;
- no worker-group/lane abstraction was added; and
- tests cover both direct tool behavior and the resulting state/event updates.

## 8. Phase 4: lifecycle polish around the thin adapter

Phase 4 is intentionally small. It is not a new orchestration phase.

### 8.1 Objective

Finish the minimum lifecycle polish required after the transport migration and
new tool surfaces are stable.

### 8.2 Allowed work

- add a `dispose` hook that closes the underlying `DaemonClient` cleanly;
- improve session-to-resource bookkeeping for resources created by plugin tools;
- tighten `session.deleted` cleanup around plugin-owned mappings;
- improve `paseo_status` and related read-only surfaces when clearer capability
  reporting helps tools degrade predictably.

### 8.3 Explicit exclusions

Phase 4 must not become:

- reconnect/recovery infrastructure;
- terminal streaming support;
- schedule/heartbeat work;
- automatic destructive cleanup of worker or terminal resources; or
- a place to revive deferred speculative config features.

## 9. Known repository mismatches to resolve while implementing phases

The following repository issues are already visible today and should be resolved
when the relevant phase touches them.

### 9.1 Transport and protocol duplication

- `lib/transport/client.ts` and `lib/transport/types.ts` currently duplicate
  protocol logic and a subset of wire types that upstream Paseo already owns.
- Phase 2 must remove this duplication as part of the transport migration.

### 9.2 Unused or partially-realized scaffolding

- `SessionMapping.createdTerminalIds` and `createdWorkerIds` exist but are not
  meaningfully populated yet.
- several inbox event kinds (`session.created`, `session.destroyed`,
  `daemon.connected`) exist in types/tool enums without current runtime
  insertion.
- some config keys remain accepted but unused today (`output.maxInboxItems`,
  `output.maxSummaryLength`, `notifications.*`, `agents.default*`).

Implementation rule: when a future phase relies on any of these surfaces, either
wire them fully in that phase or remove the unused path rather than preserving
half-implemented scaffolding.

### 9.3 Worker field assumptions

- current worker summary handling assumes fields like `worktreePath` and
  `branchName` that are not the safest basis for future work.
- Phase 3 must align worker state with current upstream agent snapshots and
  worktree RPCs before building user-facing worker/worktree tools on top.

## 10. Verification requirements for every phase

Each implementation phase in this file must update validation with the smallest
relevant commands first.

Minimum expected coverage:

- targeted unit tests for state, hook, and transport-adapter logic;
- live daemon integration coverage in `tests/integration/daemon.test.ts` for new
  client/tool methods where practical;
- host integration coverage in `tests/integration/host.test.ts` to confirm the
  plugin still loads and registers the expected tool surface;
- `pnpm format:check` or `pnpm lint` for documentation/code formatting;
- broader build/type/test commands only when the changed phase touches those
  surfaces.

Do not call a phase complete if it only adds a tool wrapper without proving that
hydration, live event handling, and local state still match the actual daemon
behavior.
