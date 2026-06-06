[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](custom_components/semantic_home/manifest.json)
[![License](https://img.shields.io/github/license/bradsjm/opencode-paseo.svg)](LICENSE)
![NPM Last Update](https://img.shields.io/npm/last-update/%40bradsjm%2Fopencode-paseo)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/bradsjm/opencode-paseo)

# Paseo plugin for OpenCode.

[Paseo](https://paseo.sh/) is a self-hosted, multi-provider, open source coding agent orchestrator.

This is an alternative to using the skills or MCP server that Paseo provides for OpenCode integration.

Like the MCP server, it exposes Paseo daemon capabilities as OpenCode tools. The key difference is that, as a native OpenCode plugin, it can use async plugin hooks and per-session state so OpenCode can be proactively nudged when something important happens instead of polling with timeouts. It is also opinionated about role boundaries: OpenCode's native agents remain the primary subagent mechanism inside the session, while Paseo is positioned for longer-lived agentic workers, daemon-managed loops, and PTY-backed terminals that complement OpenCode's built-in tooling.

## Features

- **Async, event-driven integration**: stays connected to the daemon over WebSocket and uses plugin hooks to push important activity back into OpenCode instead of relying on repeated polling or timeout-heavy waiting.
- **Hydrated local state instead of cold tool calls**: restores workers, terminals, chat rooms, capabilities, and blocking inbox items on startup so a resumed OpenCode session can pick up where it left off.
- **Inbox-driven event handling**: maps daemon events into unread/blocking inbox items with summaries, so permission requests and other notable activity become reviewable OpenCode state rather than transient daemon output.
- **Active nudges for the owning session**: nudges the relevant OpenCode session for blocking events and worker chat mentions, which is the main practical advantage over a plain MCP tool surface.
- **Complementary worker model**: positions Paseo workers and loops for longer-running agentic work without trying to replace OpenCode's native subagents inside the current session.
- **Better long-running terminal control**: exposes Paseo PTY-backed terminals for interactive and durable process management that OpenCode's built-in bash tool is not designed to handle as well.
- **Launch ownership and lifecycle tracking**: tracks both durable FIFO queued worker launches and ephemeral `paseo_worker_run` sessions, including best-effort cleanup when the owning OpenCode session disappears.
- **Conservative queued-launch rollback assessment**: when a queued worker launch with `worktreeName` fails, the plugin reports whether no cleanup was needed, an unambiguous launch-created worktree was archived automatically, or manual cleanup is still required.
- **Synthetic stall detection**: emits `worker.stalled` when an owned worker goes quiet past the configured threshold, giving OpenCode a signal that does not come directly from the daemon.

## Why use this instead of Paseo's built-in MCP server?

Use the MCP server when you only need raw access to Paseo tools from OpenCode. Use this plugin when you want OpenCode to react to ongoing Paseo activity and when you want Paseo to complement, rather than compete with, OpenCode's native agent model.

- The MCP server is primarily a request/response bridge. This plugin adds async event handling, hydrated state, inbox summaries, and OpenCode nudges so the model can be interrupted by relevant events instead of polling with timeouts.
- The MCP server exposes Paseo capabilities generically. This plugin is opinionated about workflow shape: OpenCode native agents stay the default subagent path, while Paseo is used for detached workers, daemon loops, schedules, and cross-session coordination.
- The MCP server can let you invoke terminal-related actions. This plugin gives those terminals session ownership and PTY-backed lifecycle handling, which is a better fit for long-running or interactive processes than OpenCode's built-in bash tool.
- The MCP server exposes what the daemon reports. This plugin also derives OpenCode-oriented signals such as `chat.mentioned` and `worker.stalled`.

## Prerequisites

- [OpenCode](https://opencode.ai) with plugin support
- A reachable Paseo daemon

## Installation

Add the plugin to your OpenCode project config:

```jsonc
{
  "plugin": ["@bradsjm/opencode-paseo"],
}
```

## Installing skills

While not required, you can install skills to help the language model understand and use the plugin's Paseo capabilities.

```bash
npx skills add bradsjm/opencode-paseo/skills
```

## Example use cases

### 1. Let the model react to worker events instead of polling

Paseo capability:

- Workers can block on permissions, produce notable state changes, and coordinate through chat.

Plugin improvement:

- The plugin turns those events into inbox items and nudges the owning OpenCode session for blockers and `@<worker-id>` chat mentions.

Why it matters:

- With the MCP server, the model often has to wait or poll to discover that something happened.
- With this plugin, the model can stay focused on useful work and get interrupted when Paseo actually needs attention.

### 2. Use Paseo for agentic workers without competing with OpenCode subagents

Paseo capability:

- Paseo can run detached workers, loops, schedules, and cross-session orchestration.

Plugin improvement:

- The plugin frames those capabilities as complements to OpenCode's native agents rather than replacements for them, with ownership tracking, reconnect hydration, and queue-backed worker launches.

Why it matters:

- OpenCode native agents remain the natural choice for in-session subagent behavior.
- Paseo becomes the better tool for longer-running, detached, or daemon-managed work that should outlive a single prompt/response turn.

### 3. Run long-lived terminal work through PTYs instead of built-in bash

Paseo capability:

- Paseo can create and manage terminals attached to daemon state.

Plugin improvement:

- The plugin exposes those PTY-backed terminals directly to OpenCode, with capture, input, line sending, and kill operations tied to session state.

Why it matters:

- OpenCode's built-in bash tool is fine for short commands.
- The plugin is a better fit when you need an interactive shell, durable process, REPL, watcher, or other long-running terminal workflow.

### 4. Detect when owned workers likely need intervention

Paseo capability:

- You can inspect worker state and recent activity.

Plugin improvement:

- The plugin emits a synthetic `worker.stalled` event when an owned running worker goes quiet past the configured threshold.

Why it matters:

- With the MCP server, a quiet worker can look the same as a worker you just have not checked yet.
- With this plugin, OpenCode gets an explicit signal that a worker likely needs intervention.

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

If no global config exists, `getConfig()` auto-creates `~/.config/opencode/paseo.jsonc` as a commented JSONC stub with a `$schema` attribute for editor validation.

Example stub:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/bradsjm/opencode-paseo/refs/heads/main/paseo.schema.json",
  // Configure opencode-paseo here.
  // See README.md for supported keys and defaults.
}
```

| Key                                | Type      | Default       | Notes                                                              |
| ---------------------------------- | --------- | ------------- | ------------------------------------------------------------------ |
| `enabled`                          | `boolean` | `true`        | Enables or disables the plugin entirely.                           |
| `debug`                            | `boolean` | `false`       | Enables plugin debug logging.                                      |
| `daemon.host`                      | `string`  | `"127.0.0.1"` | Localhost-only daemon host: `127.0.0.1`, `localhost`, or `::1`.    |
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

Malformed config files or invalid values trigger a warning toast and that config layer is ignored.

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

| Tool                         | Description                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `paseo_worker_list`          | Refresh and list known workers.                                                                                |
| `paseo_worker_create`        | Queue a durable detached worker launch using an OpenCode profile.                                              |
| `paseo_worker_launch_status` | Inspect a queued worker launch by `launchId`, including rollback metadata for failed worktree-backed launches. |
| `paseo_worker_run`           | Run an ephemeral non-detached worker in foreground or background mode.                                         |
| `paseo_worker_send`          | Send a message to an existing worker.                                                                          |
| `paseo_worker_wait`          | Wait on one or more workers until completion, timeout, or nudge interruption.                                  |
| `paseo_worker_cancel`        | Cancel a worker task or permanently terminate it with `forceKill`.                                             |
| `paseo_worker_archive`       | Archive a worker from the active list; daemon-backed historical records may still remain inspectable.          |
| `paseo_worker_update`        | Update worker metadata and runtime settings.                                                                   |
| `paseo_worker_inspect`       | Inspect current worker state with optional recent activity.                                                    |

`paseo_worker_create` and `paseo_worker_run` are intentionally different paths. `create` goes through the plugin-owned FIFO launch queue in `lib/worker-launch/queue.ts`, while `run` uses the non-detached transport path and tracks only in-memory ephemeral cleanup state.

`paseo_worker_create` and `paseo_worker_run` both create Paseo agents. When the plugin itself is running inside a Paseo agent environment and `PASEO_AGENT_ID` is present, those two supported creation paths automatically set the reserved label `paseo.parent-agent-id=<PASEO_AGENT_ID>`. That label is what Paseo's own UI uses to derive parent/child linkage for its `SubagentsTrack`. In this ACP usage, OpenCode has no UI for that track; the relevant UI is Paseo's UI.

When `PASEO_AGENT_ID` is unset or blank, the plugin sends no parent label. When it is set, the plugin treats `paseo.parent-agent-id` as a reserved relationship label and overrides any user-supplied value for that key. Parent-linked detached children then follow Paseo's current archive/cascade behavior model.

Scheduled `new-agent` runs and daemon-native loops are currently **not** parent-linkable through this plugin because the upstream daemon/client payloads used for those paths do not expose a labels field.

Queued launch status uses these final failure outcomes:

- `failed`: the worker launch failed and no new worktree was detected, so no cleanup is needed.
- `failed_rolled_back`: the worker launch failed after creating one unambiguous new worktree, and the plugin archived it automatically.
- `failed_needs_cleanup`: the worker launch failed and the plugin could not safely prove ownership well enough to auto-archive, or the archive attempt failed.

For failed worktree-backed launches, `paseo_worker_launch_status` returns a structured `rollback` object with `attempted`, `outcome`, `message`, optional `suggestedTool`, and optional `candidateWorktrees`. Automatic cleanup is intentionally conservative: it only runs when current daemon data shows exactly one newly appearing worktree whose `branchName` matches the queued `worktreeName`.

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

`paseo_loop_run` requires at least one verification mechanism (`verifyPrompt` or `verifyChecks`) and at least one stop bound (`maxIterations` or `maxTimeMs`). Optional string fields remain optional, but if you provide them they must be non-empty after trimming. `verifyChecks`, when provided, must contain at least one non-empty command. `verifyPrompt` is evaluated separately by the daemon verifier, so ask for explicit, checkable evidence from worker output or loop logs; successful `verifyChecks` alone do not guarantee prompt verification success.

### Schedule

| Tool                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `paseo_schedule_list`     | List daemon-managed schedules.                                  |
| `paseo_schedule_inspect`  | Inspect a schedule by ID.                                       |
| `paseo_schedule_create`   | Create a recurring schedule for `agent` or `new-agent` targets. |
| `paseo_schedule_update`   | Update an existing schedule.                                    |
| `paseo_schedule_pause`    | Pause a schedule.                                               |
| `paseo_schedule_resume`   | Resume a paused schedule.                                       |
| `paseo_schedule_delete`   | Delete a schedule.                                              |
| `paseo_schedule_run_once` | Trigger one immediate execution.                                |
| `paseo_schedule_logs`     | Retrieve recent schedule run history.                           |

For `new-agent` schedule targets, the plugin resolves the requested OpenCode profile and attempts to validate that the selected provider exists in the daemon provider snapshot for the target `cwd`.

`paseo_schedule_run_once` dispatches work asynchronously. A returned timeout warning after dispatch is not proof that the run failed; it means the daemon did not answer the request in time. Use `paseo_schedule_logs` to confirm the final outcome.

### Terminal capture semantics

- `paseo_terminal_capture` returns daemon-native `{ terminalId, lines, totalLines }` without plugin-side normalization, truncation flags, or retained-cache fallback.
- Use `start`/`end` for bounded daemon ranges, or `scrollback: true` to request capture from the start of the daemon buffer.
- After `paseo_terminal_kill` or daemon exit, a fresh daemon capture may be empty even when list metadata still exists. The plugin does not retain terminal buffers locally.
- You should still capture important output before killing a terminal.

### Chat error semantics

- Chat room mutations return daemon JSON on success. Duplicate room creation and other daemon create failures remain thrown tool errors rather than `{ error }` envelopes.

### Verification and troubleshooting

- Check `printenv | sort` (or equivalent) in the plugin/agent environment if you expect parent-linked workers; `PASEO_AGENT_ID` must be present and non-empty.
- If `paseo_worker_create` or `paseo_worker_run` launched from a Paseo-managed agent does not appear under Paseo's `SubagentsTrack`, inspect the created agent labels and confirm `paseo.parent-agent-id` was set.
- `paseo_schedule_run_once` warnings should be followed with `paseo_schedule_logs`, not treated as final failure on their own.
- Loop validation is intentionally strict: empty strings are rejected for provided optional string fields, verification requires `verifyPrompt` or non-empty `verifyChecks`, and at least one positive stop bound is required. For prompt-based verification, include concrete evidence to verify rather than only asking whether the worker completed.
- Archived workers leave the plugin's active list immediately, but daemon-backed historical records may still be inspectable with `paseo_worker_inspect`.

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

## License

MIT
