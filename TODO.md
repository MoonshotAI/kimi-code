# Agent service migration TODO

This tracks logic and behavior gaps in `packages/agent-core/src/services/agent`
against the current implementation under `packages/agent-core/src/agent`.

## PromptService / input flow

- [x] Implement `undo(count)` in `PromptService`.
- [x] Implement `clear()` in `PromptService`.
- [x] Make active-turn `steer()` enter at a step boundary instead of waiting for the whole turn to finish.
- [x] Replace plain active-turn errors with `KimiError(ErrorCodes.TURN_AGENT_BUSY)`.
- [x] Keep `retry()` origin-free for now; no current service logic consumes retry origin.
- [x] Add replay/resume handling for `turn.launch` events if the service layer takes over wire replay.
- [x] Add user prompt hook behavior if hooks remain outside `TurnRunner`.

## ContextMemory

- [x] Own the `context.splice` wire record declaration and replay application.
- [x] Keep `context.splice` as the single context mutation primitive; do not add separate append-message records.
- [x] Prevent external mutation of the returned history.
- [x] Apply restored `context.splice` records without appending duplicate records.

## Loop Transcript Assembly

- [x] Handle loop events: `step.begin`, streamed content, tool calls, tool results, and `step.end`.
- [x] Insert loop-generated assistant and tool messages into context without requiring context history to be ordered.
- [x] Add resume handling for interrupted tool calls.
- [x] Add matched-tail message removal for stop-hook cleanup in the service that owns that cleanup.

## ContextProjector

- [x] Preserve well-formed projected tool exchanges when context history is out of order.
- [x] Order or defer projected non-tool messages around open tool exchanges.

## Context Usage Accounting

- [x] Track context token count and token count with pending messages.
- [x] Feed context token status into compaction/status reporting.

## TurnRunner

- [x] Allow `afterStep` hooks to request continuation of the current turn.
- [x] Continue automatically after tool results so the model can observe tool output.
- [x] Use monotonic numeric turn ids.
- [x] Restore the turn id counter from replayed `turn.launch` records.
- [x] Emit protocol turn lifecycle events and clear the active turn with current RPC timing.
- [x] Bridge loop step lifecycle events to protocol events.
- [x] Bridge loop retry/interruption events to protocol events.
- [x] Bridge loop streaming and tool-call delta events to protocol events.
- [x] Bridge loop tool lifecycle/progress events to protocol events.
- [x] Add turn interruption telemetry and API error classification.
- [x] Add first-request readiness semantics based on first model/step activity.
- [x] Add cancel API with turn id validation and abort reason propagation.
- [x] Add user prompt hook block/append behavior.
- [x] Add stop-hook continuation.

## Goal

- [ ] Add matched-tail message removal for goal-outcome cleanup in the service that owns that cleanup.
- [ ] Add goal continuation driver and budget handling.
- [ ] Restore goal injector boundary cadence.
- [ ] Integrate goal token accounting.

## LoopService / Tool Execution

- [x] Retry loop steps after full compaction handles context overflow.
- [ ] Wait for MCP initial load before model steps.
- [x] Align service permission/loop hook types before permission wiring.
- [x] Wire prepare/authorize/finalize tool hooks for permission, synthetic results, and dedup.
- [x] Split service permission policy ordering into `PermissionPolicyService` with per-policy services.
- [x] Restore PostToolUse/PostToolUseFailure hook dispatch from service tool finalization.
- [x] Add tool lifecycle telemetry.
- [x] Make streamed tool-call collection handle indexed/interleaved tool-call parts.

## LLMRequester

- [x] Implement the real LLM transport.
- [x] Apply auth resolution from the selected model alias.
- [x] Log LLM requests.
- [x] Apply provider config, thinking config, model capability, and completion budget logic.
- [x] Convert stream callbacks into `LLMEvent` values including usage, finish reason, and timing.
- [x] Support different request shapes for normal turns and compaction.

## ToolRegistry / ToolExecutor

- [x] Finish builtin tool initialization in `AgentRuntime`; task/file/web tools are initialized there now, remaining old-Agent-bound tools are tracked in `TODO2.md`.
- [x] Implement user tool registration, records, and RPC execution outside `IToolRegistry`.
- [x] Implement MCP tool registration, status watching, auth tools, collisions, and qualified names outside `IToolRegistry`.
- [x] Track active tools and profile gating outside `IToolRegistry`.
- [x] Emit tool list updates.
- [x] Preserve tool source and tool info metadata.
- [x] Implement tool store behavior in `ToolStoreService`.
- [x] Support `resolveExecution`, approval rules, displays, and synthetic results.
- [x] Validate schemas and canonicalize tool args.
- [x] Preserve existing tool error semantics.

## PlanMode

- [x] Track plan id.
- [x] Generate and expose plan file paths.
- [x] Create plan directories/files and roll back failed enter operations.
- [x] Implement `cancel(id)`, `clear()`, and `data()`.
- [x] Use record types compatible with current plan replay.
- [x] Update replay builder state.
- [x] Emit status updates.
- [x] Replace the minimal `EnterPlanMode` and `ExitPlanMode` tools with behavior matching current tools.
- [x] Implement plan file validation, empty-plan rejection, plan review display, and options validation.
- [x] Restore plan approval outcomes.
- [x] Restore full/sparse/reentry/exit plan-mode reminders.
- [x] Restore permission policies for plan-mode writes and plan approval.

## DynamicInjector

- [x] Fix `injectedAt` bookkeeping for self-inserted injection messages.
- [x] Add clear, compaction, and message-removal lifecycle handling.
- [x] Track per-injector variants instead of marking every dynamic injection as `dynamic`.
- [x] Restore todo-list stale reminder from the TodoList implementation instead of the DynamicInjector framework.
- [x] Restore permission-mode, plugin-session-start, plan-mode, and goal injector behavior.

## FullCompaction

- [x] Implement begin/cancel/isCompacting/markCompleted state.
- [x] Emit compaction lifecycle events.
- [x] Enforce max compactions per turn.
- [x] Distinguish async compaction from blocking compaction.
- [x] Handle context overflow and retry with reduced compact counts.
- [x] Reject truncated, empty, or unusable compaction responses.
- [x] Record compaction usage and telemetry.
- [x] Post-process summaries.
- [x] Run pre/post compact hooks.
- [x] Support multi-round compaction.
- [x] Preserve current history-change cancellation semantics.
- [x] Use model capability and reserved context configuration instead of a fixed max context.

## MicroCompaction

- [x] Restore detect/reset state.
- [x] Bind reset to clear, undo, and full compaction lifecycle.
- [x] Match the current micro-compaction strategy instead of simple old tool-result truncation only.

## SwarmMode

- [x] Align records and events with current status/RPC behavior.
- [x] Emit status updates.
- [x] Add data/RPC-facing state output.
- [x] Auto-exit at turn end for task/tool triggers.
- [x] Restore tool/task/permission integration.
- [x] Verify replay restore behavior.

## Background

- [x] Add persistence, load-from-disk, and reconcile behavior.
- [x] Integrate agent task and question task types.
- [x] Record task lifecycle events.
- [x] Support full output persistence and retrieval.
- [x] Align list/stop/readOutput events and RPC behavior.
- [x] Integrate cancellation with turn/subagent lifecycle.
- [x] Improve retained-output trimming efficiency.

## Cron

- [x] Add disk loading and scheduling timers.
- [x] Add cron record/replay behavior.
- [x] Keep cron disabled for subagents.
- [x] Integrate with background/session lifecycle.
- [x] Restore full coalescing and next-run handling.
- [ ] Revisit cron `steer()` behavior after PromptService/TurnRunner settle. [TEST]

## Skill

- [x] Integrate profile system prompt, cwd listing, AGENTS.md context, and skill listing.
- [x] Support the no-skill-registry case.
- [x] Record and replay skill activation.
- [x] Restore plugin session start and plugin skill activation paths.
- [x] Recheck activation behavior after PromptService/TurnRunner settle.

## Profile / Config

- [x] Separate profile state from config state or fully model current `ConfigState`.
- [x] Resolve providers, model capabilities, model aliases, thinking config, cwd, and system prompt updates.
- [x] Preserve `setModel` validation and telemetry.
- [x] Preserve thinking toggle telemetry.
- [x] Apply provider-level thinking, sampling, and completion budget behavior.
- [x] Match current active-tool and MCP access pattern semantics.

## Usage

- [x] Emit status updates or define the replacement status event.
- [x] Account for compaction usage.
- [x] Restore usage after record replay and publish a coherent status.

## WireRecord / EventBus

- [x] Ignore record appends and event emits while wire records are restoring.
- [x] Add persistence, migrations, and restore warnings.
- [x] Add blob store support and replay builder integration.
- [x] Report persistence write errors.
- [x] Map local events to RPC/session/server protocol events.
- [x] Keep status-updated events as partial patches; consumers merge present fields and treat omitted fields as unchanged.
