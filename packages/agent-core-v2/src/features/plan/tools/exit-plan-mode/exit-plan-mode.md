Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode reminder.
- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.
- The user reviews the contents of your plan file before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it.

## When to Use
Only use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.

## What a good plan contains
Write the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:
- Context — why the change is needed and the outcome it should produce.
- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as `options`.
- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.
- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.
- Assumptions — each decision you made without the user's input, and the default you chose.
Avoid vague filler like "improve performance" or "add tests"; say what changes and how you will know it works.

## Multiple Approaches
If your plan offers multiple alternative approaches, pass them via the `options` parameter so the user can choose which one to execute — see the `options` parameter for the format, count, and reserved labels. The user sees all options alongside the host's Reject and Revise controls.

## Before Using
- If questions about preferences or trade-offs are still open, use AskUserQuestion first. In auto permission mode AskUserQuestion is unavailable: decide from context and list those decisions under Assumptions.
- Outside auto permission mode, if you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.
- Once your plan is finalized, use THIS tool to request approval.
- Do NOT use AskUserQuestion to ask "Is this plan OK?" or "Should I proceed?" - that is exactly what ExitPlanMode does.
- If rejected, revise based on feedback and call ExitPlanMode again.
