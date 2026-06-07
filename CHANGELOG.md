# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, but entries are summarized from the repository's checked-in source and git history.

## [Unreleased]

## [0.2.0] - 2026-06-07

### Added

- Added daemon-native loop tools for listing, inspecting, logging, stopping, and running bounded loops with required verification.
- Added ephemeral `paseo_worker_run` support for foreground and background non-detached workers.
- Added an opt-in Paseo-backed `task` tool override for OpenCode subagent sessions.
- Added chat room tools and reserved-label chat watching that emits `chat.mentioned` inbox events for exact worker mentions.
- Added synthetic `worker.stalled` notifications for owned workers that go quiet past the configured threshold.
- Added `paseo_worker_launch_status` for queued launches, including structured rollback metadata for failed worktree-backed launches.
- Added compact worker activity inspection and multi-worker nudge support in worker wait flows.
- Added ESLint-based linting, `require-await` enforcement, and test typechecking to development validation.

### Changed

- Removed archived workers from local in-memory state instead of continuing to expose them in active views.
- Constrained daemon host configuration to localhost-only values and expanded status output with more connection detail.
- Updated the auto-created config stub to include the schema reference.
- Reformatted the repository to Prettier-compatible spacing and then standardized on 2-space indentation.
- Updated CI and project documentation.

## [0.1.0] - 2026-06-04

### Added

- Initial release of the `@bradsjm/opencode-paseo` OpenCode plugin.
- Added event-driven Paseo daemon integration with hydrated local state, inbox summaries, and OpenCode nudges.
- Added tool surfaces for worker, terminal, worktree, permission, profile, inbox, and status operations.
- Added queue-backed durable worker launches, PTY-backed terminal management, and skill metadata for plugin-assisted usage.
