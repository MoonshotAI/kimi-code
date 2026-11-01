Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.

Write the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:
- Context — why the change is needed and the outcome it should produce.
- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as `options`.
- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.
- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.
- Assumptions — each decision you made without the user's input, and the default you chose.
Avoid vague filler like "improve performance" or "add tests"; say what changes and how you will know it works.
