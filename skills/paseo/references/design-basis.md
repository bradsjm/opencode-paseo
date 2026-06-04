# Design Basis

This skill intentionally uses one coordinator with scoped workers, not free-form group chat by default.

## Current Agentic Practice

- Anthropic Engineering, “How we built our multi-agent research system” (2025-06-13), emphasizes orchestrator-worker delegation, explicit task boundaries, parallelism only when breadth/context justify the cost, and direct worker outputs/artifacts to avoid lossy handoffs: <https://www.anthropic.com/engineering/built-multi-agent-research-system>.
- OpenAI Agents SDK orchestration guidance distinguishes manager-controlled subagents from handoffs and recommends explicit approvals for sensitive actions. In this plugin, the approval and attention surfaces are `paseo_inbox_*`, `paseo_worker_inspect`, `paseo_worker_wait`, and `paseo_permission_respond`: <https://openai.github.io/openai-agents-python/multi_agent/>.
- OpenAI Agents SDK human-in-the-loop guidance maps here to treating permission requests and wait interruptions as resumable checkpoints, not as background noise: <https://openai.github.io/openai-agents-python/human_in_the_loop/>.
- Coding work is usually less parallelizable than research unless worktree isolation, independent chunks, duplicate candidates, or long-running checks make the cost worthwhile.

## Local Plugin Evidence

- `lib/tools/worker.ts`: durable launches are queued, `paseo_worker_launch_status` returns the eventual worker ID, `paseo_worker_wait` supports multi-worker waits and nudge interruption, and `paseo_worker_inspect` exposes attention/progress/worktree routing data.
- `lib/tools/worktree.ts`: worktree list/create/archive are plugin-native, archive is explicit and removes daemon-reported workers from local state.
- `lib/tools/permission.ts`: permission responses are explicit allow/deny operations and mark matching inbox events resolved locally.
- `lib/tools/schedule.ts`: `new-agent` schedules require a profile and resolve profile-backed provider/model/mode against daemon provider state.
- `lib/chat/worker-room.ts`: `chatRoom` augments worker prompts, and exact worker-ID mentions are used for chat nudges.
