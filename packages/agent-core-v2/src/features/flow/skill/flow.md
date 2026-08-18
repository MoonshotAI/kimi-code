---
name: flow
description: Run a multi-stage flow definition with gated stage transitions — you supervise the run, dispatch workers per stage, and pass each gate on evidence. Use when the user runs /flow.
disable-model-invocation: true
---

$CONTRACT

The user's input for this activation is: `$ARGUMENTS`

If the input names no flow id, list the files under `.kimi-code/flows/` and ask which to run. If it names no task, ask for one — a run without a stated task cannot be accepted against.
