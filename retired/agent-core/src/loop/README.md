# Loop

`loop` is the stateless agent loop. It does not own sessions, wire
transport, compaction execution, permissions UI, or durable protocol
bridging. Those are host-layer responsibilities.

## Internal Owners

- `run-turn.ts` owns turn-level convergence: abort and compaction safe
  points, max-step enforcement, usage aggregation, optional continuation after
  non-tool stops, and final `TurnResult` mapping.
- `turn-step.ts` owns one provider step: pre/post step hooks, message
  construction, the atomic step envelope, LLM call, streaming callback
  wiring, and the handoff to the tool-call lifecycle.
- `tool-call.ts` owns the tool-call batch lifecycle. Classification is
  pure; preparation dispatches recorded `tool.call` events in provider
  order; terminal `tool.result` events are recorded in provider order before
  `step.end` seals the step.
- `tool-scheduler.ts` owns stateful tool execution scheduling:
  tasks with non-conflicting resource accesses may overlap, while conflicting
  tasks are serialized at provider-order boundaries.
- `llm.ts`, `events.ts`, and `types.ts` define the narrow model,
  event/transcript, message, and tool surfaces that hosts provide to the loop.

## Contracts

- The core loop must not import from host-layer implementations.
- `LLM` is the only source of model metadata, optional capability metadata,
  and system prompt.
- `buildMessages` builds the latest model-visible messages per model step.
- `dispatchEvent` is the only event path the loop writes to. The dispatcher
  records `LoopRecordedEvent`s, publishes `LoopLiveOnlyEvent`s, and routes
  shared events such as `step.begin`, `step.end`, `tool.call`, and
  `tool.result` to both transcript and live listeners.
- Live event listener failures are contained by `LoopEventDispatcher` and
  must not affect the agent loop.
- Provider usage is recorded immediately after `LLM.chat` returns, not
  after tool execution completes. Aborted tool execution must still report
  spent LLM usage.
- The transcript step envelope is intentionally partial on provider abort:
  `step.begin` may exist without `step.end`.
- Every dispatched `tool.call` must be followed by a matching `tool.result`
  unless the step is interrupted before the result dispatch point.

## Test Boundaries

The main regression guards live in `test/loop`:

- `turn-lifecycle.e2e.test.ts` covers turn convergence and usage
  aggregation.
- `transcript.e2e.test.ts` covers step ordering and durable transcript
  linkage.
- `tool-call.e2e.test.ts` and `hooks.e2e.test.ts` cover tool preparation,
  description, result finalization, and hook safety points.
- `abort.e2e.test.ts`, `error-paths.e2e.test.ts`, and `events.e2e.test.ts`
  cover abort convergence, error propagation, and live event containment.
- `streaming.e2e.test.ts` covers provider streaming callback wiring.
