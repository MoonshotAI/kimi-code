# Agent service migration TODO

This tracks logic and behavior gaps in `packages/agent-core/src/services/agent`
against the current implementation under `packages/agent-core/src/agent`.

## PromptService / input flow

- [x] Implement `undo(count)` in `PromptService`.
- [x] Implement `clear()` in `PromptService`.
- [x] Make active-turn `steer()` enter at a step boundary instead of waiting for the whole turn to finish.
- [x] Replace plain active-turn errors with `KimiError(ErrorCodes.TURN_AGENT_BUSY)`.
- [x] Keep `retry()` origin-free for now; no current service logic consumes retry origin.
- [ ] Add replay/resume equivalents for prompt/steer if the service layer takes over wire replay.
- [ ] Add user prompt hook behavior if hooks remain outside `TurnRunner`.

## ContextMemory

- [x] Own the `context.splice` wire record declaration and replay application.
- [x] Keep `context.splice` as the single context mutation primitive; do not add separate append-message records.
- [x] Prevent external mutation of the returned history.
- [x] Apply restored `context.splice` records without appending duplicate records.

## Loop Transcript Assembly

- [x] Handle loop events: `step.begin`, streamed content, tool calls, tool results, and `step.end`.
- [x] Insert loop-generated assistant and tool messages into context without requiring context history to be ordered.
- [x] Add resume handling for interrupted tool calls.
- [ ] Add matched-tail message removal for stop-hook and goal-outcome cleanup in the service that owns that cleanup.

## ContextProjector

- [ ] Preserve well-formed projected tool exchanges when context history is out of order.
- [ ] Order or defer projected non-tool messages around open tool exchanges.

## Context Usage Accounting

- [ ] Track context token count and token count with pending messages.
- [ ] Feed context token status into compaction/status reporting.

## TurnRunner

- [x] Allow `afterStep` hooks to request continuation of the current turn.
- [x] Continue automatically after tool results so the model can observe tool output.
- [ ] Emit turn and step lifecycle events.
- [ ] Replace random UUID turn ids with the monotonic turn id semantics expected by the current RPC/events.
- [ ] Add first-request readiness semantics based on first model/step activity.
- [ ] Add cancel API with turn id validation and abort reason propagation.
- [ ] Add user prompt hook block/append behavior.
- [ ] Add stop-hook continuation.
- [ ] Add goal continuation driver and budget handling.
- [ ] Integrate full compaction before/after step and overflow retry.
- [ ] Wait for MCP initial load before model steps.
- [ ] Route tool execution through permission policies and synthetic results.
- [ ] Add tool call deduplication and tool lifecycle telemetry.
- [ ] Add turn interruption telemetry and API error classification.
- [ ] Make streamed tool-call collection handle indexed/interleaved tool-call parts.
- [ ] Preserve partial assistant output on interrupted or failed streams where appropriate.

## LLMRequester

- [x] Implement the real LLM transport.
- [x] Apply auth resolution from the selected model alias.
- [ ] Log LLM requests.
- [x] Apply provider config, thinking config, model capability, and completion budget logic.
- [x] Convert stream callbacks into `LLMEvent` values including usage, finish reason, and timing.
- [x] Support different request shapes for normal turns and compaction.

## ToolRegistry / ToolExecutor

- [ ] Initialize builtin tools outside `IToolRegistry`.
- [ ] Implement user tool registration, records, and RPC execution outside `IToolRegistry`.
- [ ] Implement MCP tool registration, status watching, auth tools, collisions, and qualified names outside `IToolRegistry`.
- [ ] Track active tools and profile gating outside `IToolRegistry`.
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
- [ ] Update replay builder state.
- [x] Emit status updates.
- [x] Replace the minimal `EnterPlanMode` and `ExitPlanMode` tools with behavior matching current tools.
- [x] Implement plan file validation, empty-plan rejection, plan review display, and options validation.
- [ ] Restore plan approval outcomes.
- [x] Restore full/sparse/reentry/exit plan-mode reminders.
- [ ] Restore permission policies for plan-mode writes and plan approval.

## DynamicInjector

- [x] Fix `injectedAt` bookkeeping for self-inserted injection messages.
- [x] Add clear, compaction, and message-removal lifecycle handling.
- [x] Track per-injector variants instead of marking every dynamic injection as `dynamic`.
- [ ] Restore goal injector boundary cadence.
- [ ] Restore todo-list stale reminder from the TodoList implementation instead of the DynamicInjector framework.
- [x] Restore permission-mode, plugin-session-start, plan-mode, and goal injector behavior.
- [ ] Trigger boundary dynamic injections after full compaction completes.

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

- [ ] Restore detect/reset state.
- [ ] Bind reset to clear, undo, and full compaction lifecycle.
- [ ] Match the current micro-compaction strategy instead of simple old tool-result truncation only.

## SwarmMode

- [ ] Align records and events with current status/RPC behavior.
- [ ] Emit status updates.
- [ ] Add data/RPC-facing state output.
- [ ] Auto-exit at turn end for task/tool triggers.
- [ ] Restore tool/task/permission integration.
- [ ] Verify replay restore behavior.

## Background

- [ ] Add persistence, load-from-disk, and reconcile behavior.
- [ ] Integrate agent task and question task types.
- [ ] Record task lifecycle events.
- [ ] Support full output persistence and retrieval.
- [ ] Align list/stop/readOutput events and RPC behavior.
- [ ] Integrate cancellation with turn/subagent lifecycle.
- [ ] Improve retained-output trimming efficiency.

## Cron

- [x] Add disk loading and scheduling timers.
- [x] Add cron record/replay behavior.
- [x] Keep cron disabled for subagents.
- [ ] Integrate with background/session lifecycle.
- [x] Restore full coalescing and next-run handling.
- [ ] Revisit cron `steer()` behavior after PromptService/TurnRunner settle.

## Skill

- [ ] Integrate profile system prompt, cwd listing, AGENTS.md context, and skill listing.
- [ ] Support the no-skill-registry case.
- [ ] Record and replay skill activation.
- [ ] Restore plugin session start and plugin skill activation paths.
- [ ] Recheck activation behavior after PromptService/TurnRunner settle.

## Profile / Config

- [ ] Separate profile state from config state or fully model current `ConfigState`.
- [ ] Resolve providers, model capabilities, model aliases, thinking config, cwd, and system prompt updates.
- [ ] Preserve `setModel` validation and telemetry.
- [ ] Preserve thinking toggle telemetry.
- [ ] Apply provider-level thinking, sampling, and completion budget behavior.
- [ ] Match current active-tool and MCP access pattern semantics.

## Usage

- [ ] Emit status updates or define the replacement status event.
- [ ] Integrate goal token accounting.
- [ ] Account for compaction usage.
- [ ] Restore usage after record replay and publish a coherent status.

## WireRecord / EventBus

- [x] Ignore record appends and event emits while wire records are restoring.
- [x] Add persistence, migrations, and restore warnings.
- [ ] Add blob store support and replay builder integration.
- [x] Report persistence write errors.
- [ ] Map local events to RPC/session/server protocol events.
- [ ] Preserve status-updated aggregation behavior.
