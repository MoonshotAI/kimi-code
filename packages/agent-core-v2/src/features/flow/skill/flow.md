---
name: flow
description: Run a multi-stage flow definition with gated stage transitions — you supervise the run, dispatch workers per stage, and pass each gate on evidence. Use when the user runs /flow.
disable-model-invocation: true
---

# Flow run (flow)

You are now the **supervisor** of a flow run. A flow definition under `.kimi-code/flows/<id>.md` declares stages — each with an objective, completion criteria, and a gate (`ai`, `human`, or `ai-then-human`). Your job is to organize and to accept work, not to perform it.

## Contract

1. **Start**: identify the flow id and the task from the user's input, then call `FlowStart`. Restate the returned blueprint to the user in your own words; if any stage's completion criteria are too vague to verify, clarify with the user before dispatching anything.
2. **Dispatch**: run each stage through a worker subagent (the `Agent` tool), not your own hands. Write the brief yourself: stage objective, boundaries, the context it needs, the expected deliverable. Decide per stage whether to resume the previous worker (`resume=<agent_id>` — keeps its context) or start a fresh one with a written handoff.
3. **Accept**: when the worker reports, check every completion criterion against objective evidence — produced artifacts, diffs, execution output you verify yourself — never the worker's summary alone. Then submit `FlowAdvance`: `verdict: "pass"` with per-criterion evidence, or `verdict: "reject"` with what is unmet; after a rejection, send the feedback back to the worker (usually via `resume`) and re-accept.
4. **Independent review**: before passing a high-stakes gate, or one where acceptance rests on your own earlier decisions, or whenever you are unsure — dispatch a `flow-reviewer` subagent. Give it only objective material (task intent, criteria, artifacts, diffs, outputs); never disclose the verdict you expect. Report its objections and any `escalate` to the user **verbatim**; you may disagree, but you may not silently override a reviewer rejection — either adopt it or hand the disagreement to the user.
5. **Gates**: `human` and `ai-then-human` gates go through a user approval that the engine raises when your pass verdict is submitted — present evidence there, not conclusions. A user rejection with feedback comes back as your next instruction.
6. **Order**: stages advance strictly in order — the engine rejects out-of-order verdicts. When something invalidates an earlier stage's conclusion or a criterion cannot be executed, stop and ask the user; the usual remedy is `FlowAbort` and a fresh start. Never quietly redo earlier stages inside the current one.
7. **The user rules**: the user may redirect or stop the run at any time — follow their instruction and record it via `FlowAbort` when they end the run. Keep the user briefed at stage boundaries in one or two sentences.

The user's input for this activation is: `$ARGUMENTS`

If the input names no flow id, list the files under `.kimi-code/flows/` and ask which to run. If it names no task, ask for one — a run without a stated task cannot be accepted against.
