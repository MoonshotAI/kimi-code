---
name: flow
description: Turn the user's task into a staged flow definition, confirm it with them, and run it. Use when the user invokes /flow with a goal that no existing flow covers, or asks to design a multi-stage gated workflow for a task.
---

# Draft and run a flow (/flow)

The user wants their task run as a **flow**: a sequence of stages with explicit completion criteria, each ending in a gate (`ai`, `human`, or `ai-then-human`) that must pass before the next stage begins. No predefined flow covers this task, so you draft one, agree on it with the user, and then start the run.

The task is: `$ARGUMENTS`

If the task is empty, ask the user what this run should accomplish before drafting anything.

## Before drafting

Check the existing definitions under the project's `.kimi-code/flows/` and the user-level `~/.kimi-code/flows/`. If one already fits the task, say so and offer to start it instead (its `/flow:<id>` command activates it directly) — do not draft a near-duplicate. Draft a new flow only when nothing fits.

## Drafting principles

- **Stages are acceptance boundaries, not a todo list.** Each stage is a unit of work someone could accept or reject on evidence. Typically 3–6 stages; fewer is better than padded.
- **`objective`** is one sentence: what this stage must achieve.
- **`completion`** is the acceptance contract: observable, checkable outcomes — artifacts produced, commands that exit clean, conclusions stated. If you cannot say how a criterion would be verified, rewrite it until you can.
- **Gates express who owns the decision.** `human` for direction-setting or hard-to-reverse transitions the user must own; `ai` for mechanically verifiable work; `ai-then-human` for consequential stages that deserve an automated acceptance first and the user's sign-off after.
- **Notes** carry operating guidance for a stage (how to work, what to avoid) — put them in a `## <stage-id>` section in the body, not in the frontmatter.
- The flow `id` is kebab-case and becomes the file name; `when` describes the situations the flow suits, so it can be reused later.
- Write `objective` / `completion` / notes in the user's language; keep ids and field names as they are.

## Definition format

Write the definition to `.kimi-code/flows/<id>.md` in the project (use `~/.kimi-code/flows/` instead only if the user says the flow should be available across projects):

```markdown
---
id: harden-payments
when: A module needs a security-focused hardening pass with user sign-off
stages:
  - id: audit
    objective: Map the attack surface and rank the risks
    completion: Every entry point is listed with its trust level; the top risks are ranked with reasons
    gate: human
  - id: fix
    objective: Close the ranked risks without breaking existing behavior
    completion: Each ranked risk has a fix or a written acceptance of the risk; the test suite passes
    gate: ai-then-human
---

## audit

Read-only stage: no code changes while mapping.
```

## Confirm, then start

1. Present the draft to the user: the stage list with gates, and why you cut the stages where you did. Put genuine trade-offs (stage structure, gate ownership) through `AskUserQuestion` rather than prose menus.
2. Fold in their feedback and rewrite the file until they are satisfied.
3. When the user approves the draft, call `FlowStart` with the flow id and the task. The engine then raises a final start-review approval showing the parsed blueprint — that approval, not your conversation, is what actually starts the run. If the user rejects it with feedback, revise the definition and submit `FlowStart` again.

Note on the contract below: its Start clause describes `/flow:<id>` activations, where the engine starts the run for you. This drafting path has no automatic start — calling `FlowStart` yourself after the user approves the draft is exactly right here.

$CONTRACT
