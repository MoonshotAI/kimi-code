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

- [ ] Initialize builtin tools.
- [ ] Implement user tool registration, unregistration, records, and RPC execution.
- [ ] Implement MCP tool registration, status watching, auth tools, collisions, and qualified names.
- [ ] Track active tools and profile gating consistently.
- [ ] Emit tool list updates.
- [ ] Preserve tool source and tool info metadata.
- [ ] Implement tool store behavior.
- [ ] Support `resolveExecution`, approval rules, displays, and synthetic results.
- [ ] Validate schemas and canonicalize tool args.
- [ ] Preserve existing tool error semantics.

## PlanMode

- [ ] Track plan id.
- [ ] Generate and expose plan file paths.
- [ ] Create plan directories/files and roll back failed enter operations.
- [ ] Implement `cancel(id)`, `clear()`, and `data()`.
- [ ] Use record types compatible with current plan replay.
- [ ] Update replay builder state.
- [ ] Emit status updates.
- [ ] Replace the minimal `EnterPlanMode` and `ExitPlanMode` tools with behavior matching current tools.
- [ ] Implement plan file validation, empty-plan rejection, plan review display, options validation, and approval outcomes.
- [ ] Restore full/sparse/reentry/exit plan-mode reminders.
- [ ] Restore permission policies for plan-mode writes and plan approval.

## DynamicInjector

- [ ] Fix `injectedAt` bookkeeping for self-inserted injection messages.
- [ ] Add clear, compaction, and message-removal lifecycle handling.
- [ ] Track per-injector variants instead of marking every dynamic injection as `dynamic`.
- [ ] Restore goal injector boundary cadence.
- [ ] Restore todo-list, permission-mode, plugin-session-start, plan-mode, and goal injector behavior.

## FullCompaction

- [ ] Implement begin/cancel/isCompacting/markCompleted state.
- [ ] Emit compaction lifecycle events.
- [ ] Enforce max compactions per turn.
- [ ] Distinguish async compaction from blocking compaction.
- [ ] Handle context overflow and retry with reduced compact counts.
- [ ] Reject truncated, empty, or unusable compaction responses.
- [ ] Record compaction usage and telemetry.
- [ ] Post-process summaries.
- [ ] Run pre/post compact hooks.
- [ ] Support multi-round compaction.
- [ ] Preserve current history-change cancellation semantics.
- [ ] Use model capability and reserved context configuration instead of a fixed max context.

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

- [ ] Add disk loading and scheduling timers.
- [ ] Add cron record/replay behavior.
- [ ] Keep cron disabled for subagents.
- [ ] Integrate with background/session lifecycle.
- [ ] Restore full coalescing and next-run handling.
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
- [ ] Add persistence, blob store support, migrations, replay builder integration, and restore warnings.
- [ ] Report persistence write errors.
- [ ] Map local events to RPC/session/server protocol events.
- [ ] Preserve status-updated aggregation behavior.
