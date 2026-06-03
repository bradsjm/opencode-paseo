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

## Tools

The plugin registers OpenCode tools that mirror Paseo daemon operations. Worker
tools cover the full agent lifecycle:

| Tool                   | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `paseo_worker_list`    | List active workers from the daemon                                                          |
| `paseo_worker_create`  | Create a new background worker                                                               |
| `paseo_worker_send`    | Send a message to a worker                                                                   |
| `paseo_worker_wait`    | Wait for a worker to become idle                                                             |
| `paseo_worker_cancel`  | Cancel a worker's current task (or permanently kill with `forceKill: true`)                  |
| `paseo_worker_archive` | Archive a worker (removes from active list)                                                  |
| `paseo_worker_update`  | Update worker metadata (name, labels) and runtime settings (mode, model, thinking, features) |
| `paseo_worker_inspect` | Inspect worker state; optionally include activity timeline (`includeActivity: true`)         |

`paseo_worker_cancel` with `forceKill: true` is destructive: the worker is
permanently terminated and removed from plugin state and session bindings.

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
