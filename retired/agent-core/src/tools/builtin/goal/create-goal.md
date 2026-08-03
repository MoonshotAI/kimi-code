# NOTE: v1 legacy — the active engine is `agent-core-v2`. This prompt is only
# loaded by the v1 engine and is kept for test continuity. New changes to goal
# creation instructions should go to `packages/agent-core-v2/src/agent/goal/tools/create-goal.md`.

Create a durable, structured goal that the runtime will pursue across multiple turns.

Call `CreateGoal` only when:

- the user explicitly asks you to start a goal or work autonomously toward an outcome, or
- a host goal-intake prompt asks you to create one.

Do NOT create a goal for greetings, ordinary questions, or vague requests that lack a
verifiable completion condition. A goal needs a checkable end state.

`completionCriterion` is required. When the request is vague (e.g. "finish the project",
"make it better"), you MUST first ask the user — via `AskUserQuestion` — what "done"
concretely means and how it will be verified, then create the goal with their answer.
Do not invent a completion criterion on your own; a fabricated criterion sends you
autonomously chasing a target the user never agreed to. If the user clearly insists on a
vague goal after you warn them, record their own wording as the criterion and proceed.

Keep `objective` concise; reference long task descriptions by file path rather than pasting
them.

Creating a goal fails if one already exists, so use `replace: true` only when the user explicitly
wants to abandon the current goal and start a new one.
