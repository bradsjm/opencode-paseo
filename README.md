# opencode-paseo

OpenCode plugin that connects to the [Paseo](https://github.com/paseo-run/paseo) daemon. It exposes Paseo's worker orchestration, terminal sessions, permission handling, git worktrees, and scheduled runs as OpenCode tools, and keeps the session informed through an event-driven inbox.

## Prerequisites

- [OpenCode](https://opencode.ai) with plugin support
- Paseo daemon running locally (default: `localhost:6767`)

## Installation

Add the plugin to your OpenCode project configuration (`opencode.json` or `opencode.jsonc`):

```jsonc
{
    "plugin": ["@opencode-paseo/opencode-paseo"],
}
```

Then install the package:

```bash
npm install @opencode-paseo/opencode-paseo
```

On startup the plugin connects to the Paseo daemon via WebSocket, hydrates the local state with existing workers, terminals, and sessions, and subscribes to live daemon events.

## How it works

1. **Connection** — the plugin opens a WebSocket to the Paseo daemon and authenticates with the configured password.
2. **Hydration** — on connect, it fetches the current daemon state (workers, terminals, sessions) and populates the local inbox.
3. **Live events** — daemon events (`worker.*`, `terminal.*`, `permission.*`, `session.*`) are mapped to inbox events in real time. Blocking events (worker failures, permission requests, terminal errors) trigger session nudges so the agent notices them.
4. **Session cleanup** — when an OpenCode session is deleted, the plugin unbinds durable session ownership and best-effort cancels any tracked ephemeral `paseo_worker_run` workers.

## Configuration

The plugin reads `paseo.jsonc` (or `paseo.json`) from:

1. **Global** — `~/.config/opencode/paseo.jsonc` (auto-created as a commented JSONC stub if missing)
2. **OpenCode config dir** — `$OPENCODE_CONFIG_DIR/paseo.jsonc`
3. **Project** — `.opencode/paseo.jsonc`

Later files override earlier ones.

| Key                                | Type      | Default       | Description                                                                            |
| ---------------------------------- | --------- | ------------- | -------------------------------------------------------------------------------------- |
| `enabled`                          | `boolean` | `true`        | Enable or disable the plugin                                                           |
| `debug`                            | `boolean` | `false`       | Enable debug logging                                                                   |
| `daemon.host`                      | `string`  | `"127.0.0.1"` | Daemon host (`127.0.0.1`, `localhost`, or `::1` only)                                  |
| `daemon.port`                      | `number`  | `6767`        | Daemon port                                                                            |
| `daemon.password`                  | `string`  | —             | Authentication password                                                                |
| `daemon.connectionTimeoutMs`       | `number`  | `3000`        | Connection timeout                                                                     |
| `output.maxInboxItems`             | `number`  | `100`         | Max inbox items in memory                                                              |
| `output.maxSummaryLength`          | `number`  | `500`         | Max summary text length                                                                |
| `notifications.enabled`            | `boolean` | `true`        | Enable session nudges                                                                  |
| `notifications.blockingOnly`       | `boolean` | `false`       | Only nudge on blocking events                                                          |
| `notifications.stalledThresholdMs` | `number`  | `120000`      | Inactivity threshold before a running worker gets a best-effort `worker.stalled` event |
| `agents.defaultAgent`              | `string`  | —             | Default agent name                                                                     |
| `agents.defaultModel`              | `string`  | —             | Default model for workers                                                              |

Malformed config files and invalid values surface a warning toast and that layer is ignored. If `daemon.host` is set outside the localhost-only allowlist, the plugin warns and enforces `127.0.0.1` at runtime.

The plugin also performs a best-effort stalled-worker heuristic: if an owned worker remains effectively active (`running`/`initializing`, not `idle`, not permission-blocked) without new upstream activity for at least `notifications.stalledThresholdMs`, the plugin emits a synthetic non-blocking `worker.stalled` inbox event and, when non-blocking notifications are enabled, nudges the owning OpenCode session. The stall clears automatically when activity resumes or the worker leaves the running path.

## Tools

The plugin registers the following tools in OpenCode.

### Status

| Tool           | Description                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `paseo_status` | Check daemon connection status and current state summary (workers, terminals, inbox counts, blocking breakdown) |

### Inbox

| Tool                 | Description                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `paseo_inbox_read`   | Read inbox events with filtering by kind, resource ID, and read status. Supports pagination and mark-read. |
| `paseo_inbox_status` | Get inbox summary: unread count, blocking count, and breakdowns by event kind and resource                 |

### Terminal

| Tool                        | Description                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `paseo_terminal_list`       | List all known terminals (ID, title, status, line count). Optionally filter by working directory.               |
| `paseo_terminal_create`     | Create a new terminal session bound to the current OpenCode session. Supports initial command and args.         |
| `paseo_terminal_capture`    | Capture output from a terminal. Returns content with line count. Supports ANSI stripping.                       |
| `paseo_terminal_send_input` | Send raw keystrokes to a running terminal. Characters are sent verbatim without escape-sequence interpretation. |
| `paseo_terminal_send_lines` | Send one or more complete command lines to a running terminal. Lines are joined with newlines.                  |
| `paseo_terminal_kill`       | Kill a running terminal session. Destructive — capture important output first.                                  |

### Permission

| Tool                       | Description                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `paseo_permission_respond` | Respond to a pending permission request from a worker. Allow or deny with optional message, interrupt flag, and action selection. |

### Profile

| Tool                 | Description                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `paseo_profile_list` | List available OpenCode agent profiles. Profiles define the model, mode, and behavior for workers. |

### Worker

| Tool                   | Description                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paseo_worker_list`    | List all workers with ID, status, cwd, provider/model/mode, and permission data                                                                                                                     |
| `paseo_worker_create`  | Create a durable detached worker through the queued launch path. Returns a launch receipt immediately and preserves existing launch semantics.                                                      |
| `paseo_worker_run`     | Create an ephemeral non-detached worker. Blocks until completion by default, supports `background: true`, and best-effort cancels on abort or owning session deletion while the plugin stays alive. |
| `paseo_worker_send`    | Send a text message to an existing worker                                                                                                                                                           |
| `paseo_worker_wait`    | Wait on one or more workers with `workerIds`, `waitFor: "any" \| "all"`, a global timeout, and early interruption on owned-worker nudge events                                                      |
| `paseo_worker_cancel`  | Cancel a worker's current task. Use `forceKill=true` for permanent termination.                                                                                                                     |
| `paseo_worker_archive` | Archive a worker (removed from active list)                                                                                                                                                         |
| `paseo_worker_update`  | Update worker name, labels, and runtime settings (mode, model, thinking, features)                                                                                                                  |
| `paseo_worker_inspect` | Inspect a worker's current state. Optionally includes recent activity timeline.                                                                                                                     |

`paseo_worker_run` is intentionally separate from `paseo_worker_create`: it uses the non-detached transport path, keeps only in-memory ephemeral bookkeeping, and does not participate in launch queue, hydration, or restart recovery. In foreground mode it returns a completion/timeout/aborted payload for that single run. In background mode it returns immediately with the created `workerId` plus `detached: false` / `ephemeral: true` lifecycle markers.

`paseo_worker_wait` accepts `workerIds: string[]` (one or more, deduplicated), optional `waitFor` (defaults to `"all"`), and optional `timeout` in milliseconds. It returns a structured payload with the completed per-worker `results`, any `pendingWorkerIds`, plus `timedOut` and `interruptedByNudge` flags so the controller can tell whether the wait completed normally, hit the timeout, or stopped because the current OpenCode session received a nudge-eligible event for one of its owned workers, including fresh synthetic `worker.stalled` events.

### Worktree

| Tool                     | Description                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `paseo_worktree_list`    | List git worktrees for a project                                                          |
| `paseo_worktree_create`  | Create a new git worktree with optional slug, base ref, action, and GitHub PR association |
| `paseo_worktree_archive` | Archive a git worktree                                                                    |

### Loop

| Tool                  | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `paseo_loop_run`      | Start a daemon-native loop with explicit verification and bounded stop conditions               |
| `paseo_loop_list`     | List daemon-native loops known to the Paseo daemon                                              |
| `paseo_loop_inspect`  | Inspect a specific daemon-native loop, including its recorded iterations when available         |
| `paseo_loop_logs`     | Read snapshot/cursor-based loop logs with incremental `entries` and `nextCursor`               |
| `paseo_loop_stop`     | Stop a running daemon-native loop                                                               |

Loop tools are thin wrappers over the daemon's native loop RPCs. The plugin does not add its own loop controller, verifier orchestration, polling layer, or archive behavior.

`paseo_loop_run` requires at least one verification mechanism (`verifyPrompt` or `verifyChecks`) and at least one stop bound (`maxIterations` or `maxTimeMs`). Numeric loop timing fields use milliseconds to match the rest of the plugin surface.

`paseo_loop_logs` is snapshot/cursor-based rather than a streaming follow mode. It returns the daemon payload envelope, including `entries`, `nextCursor`, `error`, and the optional loop summary when present.

`archive` is intentionally not exposed on `paseo_loop_run` yet because the currently installed upstream JavaScript client does not forward that field reliably.

### Schedule

| Tool                      | Description                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `paseo_schedule_list`     | List all configured schedules with cadence, target, and status                                                            |
| `paseo_schedule_inspect`  | Inspect a specific schedule's full configuration and status                                                               |
| `paseo_schedule_create`   | Create a recurring schedule. Supports interval (`every`) or `cron` cadence with targets: `self`, `agent`, or `new-agent`. |
| `paseo_schedule_update`   | Update schedule properties (name, prompt, cadence, timezone, profile, etc.)                                               |
| `paseo_schedule_pause`    | Pause a running schedule                                                                                                  |
| `paseo_schedule_resume`   | Resume a paused schedule                                                                                                  |
| `paseo_schedule_delete`   | Delete a schedule permanently                                                                                             |
| `paseo_schedule_run_once` | Trigger a single immediate execution without affecting the regular cadence                                                |
| `paseo_schedule_logs`     | Retrieve recent execution logs for a schedule                                                                             |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Typecheck
pnpm typecheck

# Test
pnpm test

# Integration test (requires opencode CLI)
pnpm test:integration

# Format and lint
pnpm format
pnpm lint
```

## License

MIT
