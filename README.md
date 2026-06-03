# opencode-paseo

Lightweight OpenCode plugin for using existing Paseo daemon capabilities from
inside OpenCode.

This project is intended to be a thin developer-focused adapter, not a new
orchestration platform. Paseo already owns local terminals, background agents,
worktrees, permissions, and daemon events. OpenCode already owns reasoning,
editing, tool use, and user interaction. This plugin should connect those two
systems with the smallest useful OpenCode-native surface.

## Why this exists

OpenCode can run commands, but developer workflows often need stateful local
resources that outlive one shell call:

- dev servers, watch-mode tests, REPLs, and log tails
- background Paseo agents that continue working across turns
- agent permission requests and other blocking events
- worktree-backed parallel coding workflows
- existing terminals or workers that should be reused instead of duplicated

The plugin lets OpenCode see Paseo daemon state and events through structured
tools instead of relying only on ad hoc CLI output and conversation memory.

A core goal is to help OpenCode use Paseo's async terminals and background
workers so long-running local work can continue without forcing LLM models to
wait unless a workflow explicitly chooses to block. The plugin should make it
cheap to start work, observe progress, and come back for results later.

## Design stance

- **Thin adapter:** mirror existing Paseo daemon/CLI contracts where possible.
- **Async by default:** favor flows where OpenCode can start local work,
  continue reasoning, and only wait when a task actually needs synchronous
  completion.
- **YAGNI:** add only the OpenCode tool or state needed for a real developer
  workflow.
- **Ephemeral state:** prefer startup hydration and live daemon events over
  plugin-owned durable state.
- **Low maintenance:** keep protocol-specific code isolated so OpenCode and
  Paseo can evolve without forcing broad plugin rewrites.
- **Local developer scope:** preserve the localhost daemon boundary unless the
  product requirements explicitly change.

See `PLAN.md` for the authoritative technical roadmap for post-Phase-1 work.
`SPEC.md` is deprecated for planning and retained only as a Phase 1
implementation reference.

## Current status

Phase 1 is implemented. The plugin currently provides visibility and inbox
primitives that lay the groundwork for later async terminal and worker tools.
Today it:

1. loads layered plugin configuration;
2. enforces a localhost-only daemon host;
3. connects to the local Paseo daemon over WebSocket;
4. hydrates current Paseo workers and terminals at startup;
5. keeps in-memory connection, capability, worker, terminal, session, and inbox
   state;
6. seeds unread inbox entries for workers that already require attention;
7. translates selected live daemon events into a compact inbox model; and
8. registers three OpenCode tools.

The plugin currently does **not** create terminals, send terminal input, spawn
workers, respond to permissions, manage worktrees, or schedule jobs. The async
execution goal described above is the design direction for future phases, not a
claim that this Phase 1 build already exposes those controls.

## Tools

| Tool                 | Description                                     |
| -------------------- | ----------------------------------------------- |
| `paseo_status`       | Daemon connection status and state summary      |
| `paseo_inbox_read`   | Read inbox events with filtering and pagination |
| `paseo_inbox_status` | Inbox summary: unread, blocking, breakdowns     |

These tools are intentionally read-oriented in Phase 1. Their job is to give
OpenCode enough live state to avoid blind polling and prepare for later
non-blocking terminal and worker workflows.

## Configuration

Config files are loaded in layers. Later layers override earlier layers:

1. Global: `~/.config/opencode/paseo.jsonc`
2. Config dir: `$OPENCODE_CONFIG_DIR/paseo.jsonc`
3. Project: `.opencode/paseo.jsonc`

JSON files with the same names are also supported. When no global config exists,
the plugin creates a minimal global `paseo.jsonc` schema stub.

### Config options

| Key                          | Type    | Default       | Description                           |
| ---------------------------- | ------- | ------------- | ------------------------------------- |
| `enabled`                    | boolean | `true`        | Enable/disable the plugin             |
| `debug`                      | boolean | `false`       | Enable debug logging                  |
| `daemon.host`                | string  | `"127.0.0.1"` | Daemon host (localhost only)          |
| `daemon.port`                | integer | `6767`        | Daemon WebSocket port                 |
| `daemon.connectionTimeoutMs` | integer | `3000`        | Connection timeout                    |
| `daemon.password`            | string  | unset         | Optional bearer token for daemon auth |
| `output.maxInboxItems`       | integer | `100`         | Max inbox items per response          |
| `output.maxSummaryLength`    | integer | `500`         | Max event summary length              |
| `notifications.enabled`      | boolean | `true`        | Accepted but currently unused         |
| `notifications.blockingOnly` | boolean | `false`       | Accepted but currently unused         |
| `agents.defaultAgent`        | string  | unset         | Accepted but currently unused         |
| `agents.defaultModel`        | string  | unset         | Accepted but currently unused         |

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
```

`pnpm test:integration` requires the `opencode` CLI on `PATH` and a reachable
local Paseo daemon for live-daemon coverage.

## Current constraints

- Localhost-only daemon connection is enforced in config validation.
- State is in-memory and process-local.
- No daemon restart recovery or reconnect loop beyond initial connection.
- No terminal promotion or automatic shell rerouting.
- No auto-approval of permissions.
- No direct terminal control, worker control, worktree, or schedule tools in the
  current plugin phase.
- Async terminal/worker execution is a design goal, but the current release only
  exposes the visibility and inbox pieces needed to support that direction.
