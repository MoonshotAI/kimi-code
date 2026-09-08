# State Machine Naming Guide

Naming conventions for states, events, actions, guards, and invoked actors in agent-core-v2's XState machines. Derived from XState's official naming guidance (Stately, "State Machines — What's in a name?") and the messaging convention (commands imperative, events past tense), adapted to the actor-tree semantics of this codebase.

## Events: three categories

Classify an event by **what the receiver does with it**, not by whether it carries a payload.

1. **Command — imperative verb**. Asks the receiver to do something. Examples: `input.submit`, `input.steer`, `input.abort`, `input.remind`, `tool.abort`, `turn.abort`, `turn.drain`, `turn.notify`, `turn.spawn_tools`, `context.reset`.
2. **Fact — past participle**. Reports that something already happened; usually drives transitions or parent-level bookkeeping. Examples: `llm.sent`, `llm.done`, `llm.failed.syntax`, `llm.failed.remote`, `llm.retrying`, `llm.recovering`, `tool.done`, `tool.failed`, `tool.aborted`, `tool.detached`, `turn.reminders_consumed`, `todo.used`. Emitted events are facts by definition: `turn.started`, `turn.done`, `turn.failed`, `turn.aborted`, `turn.aborting`, `agent.created`, `agent.forked`, `agent.switched`, `agent.stopped`, `agent.failed`, `usage.updated`.
3. **Data stream — noun (the data's own name)**. Delivers one piece of streaming data; the receiver accumulates or forwards it. Grouped under a `streaming` sub-namespace: `llm.streaming.part`, `llm.streaming.headers`, `llm.streaming.usage`, `llm.streaming.finish`, `llm.streaming.message_id`; also `tool.update`, `usage.record`.

Boundary example: `llm.streaming.finish` carries completion metadata that feeds the accumulator (data stream, noun), while `llm.done` is the payload-free stream terminator that drives the transition (fact, past participle).

## Spelling

- `dot.case` namespaces: `<domain>.<name>` — `llm.*`, `tool.*`, `turn.*`, `input.*`, `agent.*`, `usage.*`, `context.*`, `todo.*`, `cron.*`, `goal.*`, `reminder.*`, `dateChange.*`, `interaction.*`, `runtime.*`.
- Multi-word segments use `snake_case`: `turn.spawn_tools`, `turn.reminders_consumed`, `llm.streaming.message_id`. Never kebab-case or camelCase inside a segment.
- Data-stream events live under a `streaming` sub-namespace so the category is readable from the event name, and one wildcard declaration (`'llm.streaming.*'`) can handle or forward the whole group.
- Reserved prefixes that user events must not occupy: `xstate.*` (framework built-ins) and `@xstate.*` (inspection events).

## States, actions, guards, actors

- **States**: nouns, adjectives, or gerunds — `idle`, `running`, `active`, `thinking`, `acting`, `draining`, `preparing`, `executing`, `finishing`, `succeeded`, `failed`, `aborted`.
- **Named actions**: verb phrases — `forwardToParent`, `spawnTurnTools`, `abortTurnTools`.
- **Named guards**: adjectives, past participles, or boolean phrases — `isLoggedIn`-style.
- **Invoked actors**: noun phrases — `requestActor`, `executeActor`, `preparingActor`, `finishingActor`, `cronEffects`.

## Consistency

Use one style per element kind across all machines. When adding an event, first decide its category (command / fact / data stream), then spell it by the rules above; when adding a data-stream event to a family that already has a `streaming` sub-namespace, put it there.
