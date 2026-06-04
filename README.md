# opencode-paseo

OpenCode plugin that connects to a local [Paseo](https://github.com/paseo-run/paseo) daemon and exposes daemon capabilities as OpenCode tools. The plugin also keeps per-session state for workers, terminals, chat rooms, queued launches, and inbox events so OpenCode can react to blocking or notable daemon activity.

## Features

- Connects to the Paseo daemon over WebSocket and hydrates local state on startup.
- Registers OpenCode tools for chat, inbox, loops, permissions, profiles, schedules, terminals, workers, and worktrees.
- Maps daemon events into an inbox with unread/blocking summaries.
- Nudges owning OpenCode sessions for blocking events and chat mentions.
- Tracks both durable queued worker launches and ephemeral `paseo_worker_run` sessions.
- Emits a synthetic `worker.stalled` inbox event when an owned running worker goes quiet past the configured threshold.

## Prerequisites

- [OpenCode](https://opencode.ai) with plugin support
- A local Paseo daemon reachable on `127.0.0.1`, `localhost`, or `::1`

## Installation

Add the plugin to your OpenCode project config:

```jsonc
{
    "plugin": ["@opencode-paseo/opencode-paseo"],
}
```

Install the package:

```bash
pnpm add @opencode-paseo/opencode-paseo
```

## Runtime flow

1. `index.ts` loads config, logger, in-memory state, and the transport client.
2. The plugin connects to the daemon. If the daemon is unavailable, the plugin returns an empty plugin surface.
3. `lib/hydration/hydrate.ts` seeds workers, terminals, chat rooms, capabilities, and any blocking inbox items from current daemon state.
4. `lib/hooks/daemon-events.ts` translates live daemon events into state updates, inbox events, and nudges.
5. `lib/chat/watch.ts` watches worker chat rooms and creates `chat.mentioned` inbox events when known workers are mentioned.
6. On `session.deleted`, the plugin unbinds session ownership and best-effort cancels tracked ephemeral workers created by `paseo_worker_run`.

## Configuration

The plugin loads `paseo.jsonc` or `paseo.json` from these layers, with later layers overriding earlier ones:

1. Global: `~/.config/opencode/paseo.jsonc` or `~/.config/opencode/paseo.json`
2. OpenCode config dir: `$OPENCODE_CONFIG_DIR/paseo.jsonc` or `$OPENCODE_CONFIG_DIR/paseo.json`
3. Project: nearest `.opencode/paseo.jsonc` or `.opencode/paseo.json`

If no global config exists, `getConfig()` auto-creates `~/.config/opencode/paseo.jsonc` as a commented JSONC stub.

| Key                                | Type      | Default       | Notes                                                              |
| ---------------------------------- | --------- | ------------- | ------------------------------------------------------------------ |
| `enabled`                          | `boolean` | `true`        | Enables or disables the plugin entirely.                           |
| `debug`                            | `boolean` | `false`       | Enables plugin debug logging.                                      |
| `daemon.host`                      | `string`  | `"127.0.0.1"` | Runtime is restricted to `127.0.0.1`, `localhost`, or `::1`.       |
| `daemon.port`                      | `number`  | `6767`        | Daemon port.                                                       |
| `daemon.password`                  | `string`  | unset         | Optional daemon authentication password.                           |
| `daemon.connectionTimeoutMs`       | `number`  | `3000`        | WebSocket connection timeout.                                      |
| `output.maxInboxItems`             | `number`  | `100`         | Maximum inbox items retained in memory.                            |
| `output.maxSummaryLength`          | `number`  | `500`         | Maximum summary length for inbox text.                             |
| `notifications.enabled`            | `boolean` | `true`        | Enables OpenCode nudges from plugin events.                        |
| `notifications.blockingOnly`       | `boolean` | `false`       | Restricts nudges to blocking events only.                          |
| `notifications.stalledThresholdMs` | `number`  | `120000`      | Quiet-period threshold before emitting synthetic `worker.stalled`. |
| `agents.defaultAgent`              | `string`  | unset         | Optional default agent name.                                       |
| `agents.defaultModel`              | `string`  | unset         | Optional default model name.                                       |

Malformed config files or invalid values trigger a warning toast and that config layer is ignored. If `daemon.host` is outside the localhost allowlist, the plugin warns and enforces `127.0.0.1` at runtime.

## Tool surface

### Status

| Tool           | Description                                                      |
| -------------- | ---------------------------------------------------------------- |
| `paseo_status` | Check daemon connection status and current plugin state summary. |

### Chat

| Tool                 | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `paseo_chat_create`  | Create a new Paseo chat room.                                                   |
| `paseo_chat_list`    | List all Paseo chat rooms.                                                      |
| `paseo_chat_inspect` | Inspect a specific chat room.                                                   |
| `paseo_chat_delete`  | Delete a chat room permanently.                                                 |
| `paseo_chat_post`    | Post a message to a chat room.                                                  |
| `paseo_chat_read`    | Read chat messages with optional `limit`, `since`, and `authorAgentId` filters. |
| `paseo_chat_wait`    | Wait for newer chat messages after the latest currently known message.          |

When a worker carries the reserved `opencodePaseo.chatRoom` label, the plugin watches that room and emits `chat.mentioned` inbox events when known workers are mentioned with exact `@<worker-id>` tokens.

### Inbox

| Tool                 | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `paseo_inbox_read`   | Read inbox events with filters for unread status, kind, and resource ID. |
| `paseo_inbox_status` | Return unread/blocking counts plus kind and resource breakdowns.         |

### Terminal

| Tool                        | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `paseo_terminal_list`       | List known terminals, optionally filtered by working directory. |
| `paseo_terminal_create`     | Create a new terminal bound to the current OpenCode session.    |
| `paseo_terminal_capture`    | Capture terminal output with optional ANSI stripping.           |
| `paseo_terminal_send_input` | Send raw input to a running terminal.                           |
| `paseo_terminal_send_lines` | Send complete command lines to a running terminal.              |
| `paseo_terminal_kill`       | Kill a running terminal session.                                |

### Permission and profile

| Tool                       | Description                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `paseo_permission_respond` | Respond to a worker permission request with allow/deny behavior and optional action selection. |
| `paseo_profile_list`       | List available OpenCode agent profiles for the current workspace.                              |

### Worker

| Tool                         | Description                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `paseo_worker_list`          | Refresh and list known workers.                                               |
| `paseo_worker_create`        | Queue a durable detached worker launch using an OpenCode profile.             |
| `paseo_worker_launch_status` | Inspect a queued worker launch by `launchId`.                                 |
| `paseo_worker_run`           | Run an ephemeral non-detached worker in foreground or background mode.        |
| `paseo_worker_send`          | Send a message to an existing worker.                                         |
| `paseo_worker_wait`          | Wait on one or more workers until completion, timeout, or nudge interruption. |
| `paseo_worker_cancel`        | Cancel a worker task or permanently terminate it with `forceKill`.            |
| `paseo_worker_archive`       | Archive a worker from the active list.                                        |
| `paseo_worker_update`        | Update worker metadata and runtime settings.                                  |
| `paseo_worker_inspect`       | Inspect current worker state with optional recent activity.                   |

`paseo_worker_create` and `paseo_worker_run` are intentionally different paths. `create` goes through the plugin-owned FIFO launch queue in `lib/worker-launch/queue.ts`, while `run` uses the non-detached transport path and tracks only in-memory ephemeral cleanup state.

### Worktree

| Tool                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `paseo_worktree_list`    | List git worktrees for a project.                              |
| `paseo_worktree_create`  | Create a new worktree from project context and git ref inputs. |
| `paseo_worktree_archive` | Archive a worktree with explicit repo/worktree identification. |

### Loop

| Tool                 | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| `paseo_loop_run`     | Run a daemon-native loop with required verification and bounded stop conditions. |
| `paseo_loop_list`    | List daemon-native loops.                                                        |
| `paseo_loop_inspect` | Inspect a loop by ID.                                                            |
| `paseo_loop_logs`    | Read cursor-based loop logs.                                                     |
| `paseo_loop_stop`    | Stop a running loop.                                                             |

`paseo_loop_run` requires at least one verification mechanism (`verifyPrompt` or `verifyChecks`) and at least one stop bound (`maxIterations` or `maxTimeMs`).

### Schedule

| Tool                      | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `paseo_schedule_list`     | List daemon-managed schedules.                                           |
| `paseo_schedule_inspect`  | Inspect a schedule by ID.                                                |
| `paseo_schedule_create`   | Create a recurring schedule for `self`, `agent`, or `new-agent` targets. |
| `paseo_schedule_update`   | Update an existing schedule.                                             |
| `paseo_schedule_pause`    | Pause a schedule.                                                        |
| `paseo_schedule_resume`   | Resume a paused schedule.                                                |
| `paseo_schedule_delete`   | Delete a schedule.                                                       |
| `paseo_schedule_run_once` | Trigger one immediate execution.                                         |
| `paseo_schedule_logs`     | Retrieve recent schedule run history.                                    |

For `new-agent` schedule targets, the plugin resolves the requested OpenCode profile and attempts to validate that the selected provider exists in the daemon provider snapshot for the target `cwd`.

## Development commands

| Command                 | Purpose                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `pnpm install`          | Install dependencies.                                                              |
| `pnpm build`            | Build JavaScript bundles and declaration files.                                    |
| `pnpm typecheck`        | Run TypeScript without emitting output.                                            |
| `pnpm test`             | Run unit tests via Node's built-in runner.                                         |
| `pnpm test:integration` | Run integration tests against a real OpenCode host; requires `opencode` on `PATH`. |
| `pnpm format`           | Rewrite files with Prettier.                                                       |
| `pnpm format:check`     | Check formatting without rewriting.                                                |
| `pnpm lint`             | Prettier check alias.                                                              |
| `pnpm dev`              | Run `tsup` in watch mode.                                                          |

## Project structure

```text
index.ts                  Plugin assembly and registration
lib/config.ts             Config loading, layering, validation, and warnings
lib/chat/                 Chat room normalization and watcher logic
lib/hooks/                Daemon event mapping into local state and inbox events
lib/hydration/            Startup hydration from daemon snapshots
lib/inbox/                Inbox read/status helpers, IDs, and summary truncation
lib/state/                In-memory plugin state, session bindings, and type mapping
lib/tools/                OpenCode tool definitions grouped by feature
lib/transport/            Daemon client adapter and plugin-owned transport types
lib/worker-launch/        FIFO durable worker launch queue
lib/notifier.ts           Nudge policy and message formatting
lib/profile.ts            OpenCode profile lookup and mapping helpers
lib/worker-stall-monitor.ts Synthetic stall detection for owned workers
tests/                    Unit and integration coverage
```

Each multi-file `lib/*` folder now has its own `README.md` and `AGENTS.md` with local implementation notes.

## Development notes

- `tsconfig.json` includes `index.ts` and `lib/**/*`, but excludes `tests/`, so test changes should be validated by running the relevant test command.
- `pnpm build` depends on `jsonc-parser` remaining installed because `tsup.config.ts` bundles it via `noExternal`.
- `pnpm lint` is a Prettier check, not an ESLint pass.

## License

MIT
