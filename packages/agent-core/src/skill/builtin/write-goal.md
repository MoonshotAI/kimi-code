---
name: write-goal
description: Help the user craft a well-specified `/goal` objective for goal mode — turn a rough intention into a completion contract with a clear finish line, proof, boundaries, and stop rule. Use when the user asks for help writing, refining, or improving a goal.
---

# Write a good goal (write-goal)

Help the user turn a rough intention into a `/goal` objective that goal mode can pursue across many turns without supervision. A goal is not a task description — it is a completion contract. It says what must become *true*, how that truth is *proven*, where the work may and may not *reach*, and when to *stop and report* instead of grinding on.

This skill is about authoring the objective text together with the user. Drafting and starting are separate steps: you settle the wording first, and only once the user has approved it do you start the goal by calling `CreateGoal`. The user still gets a final confirmation before it runs.

## Rules of engagement

- **Only help when the user has asked for it.** Never volunteer to wrap an ordinary request in a goal, and never start one on your own. A normal "fix this test" is a normal request; treat it as a goal only when the user says they want a goal. If a task looks like it would suit goal mode, you may mention that once — but wait for the user to choose.
- **Write in the user's language.** Draft the objective in whatever language the user is writing to you in. If the project configuration or a saved memory names a preferred language, honor that instead. Keep the surrounding discussion in the same language.
- **Show before you start.** Always present the full drafted goal back to the user and get their agreement before anything runs. The user should read the exact text that will become the objective, not a paraphrase of it.
- **Draft with the user, not for them.** Goal-writing is a conversation. Offer a draft, explain the choices you made, invite changes, and fold the feedback in. Expect more than one round.
- **Respect the user's final call.** If, after you have pointed out what is vague or risky, the user still wants a looser or thinner goal, write the goal they asked for. Note the trade-off once; do not keep relitigating it or quietly "improve" the wording against their wishes.

## What makes a goal good

The strongest goals share one shape: they define **proof, not effort**. "Keep improving the code" describes effort and never ends. "Done when `npm test` exits 0 and no file outside `src/auth` changed" describes proof and is checkable. Aim for a contract with these parts:

1. **End state** — the condition that must become true. Name the finish line concretely: a passing suite, an empty queue, a search that returns zero matches, a deployed artifact.
2. **Proof** — the observable evidence that the end state holds. Prefer things the agent can run and you can inspect afterward: a command's exit code, a test count, a `grep`/`rg` with no hits, a file that now exists, a metric over a threshold.
3. **Boundaries** — what the work may and may not touch. Name the scope (which module, which directory) and the off-limits actions (do not edit the spec, do not change unrelated files, do not make destructive data changes).
4. **The loop** — when the work is iterative, say how to iterate: rerun the check after each change, work through the queue item by item, replay the failing cases until they pass.
5. **The stop rule** — how to end honestly when "done" is not reachable. Add a turn or budget cap, a "stop and ask before widening scope" clause, and an explicit blocked path ("if an external service is down, record it and move on") so the agent reports instead of faking a pass or looping forever.

Two habits make almost any goal better:

- **Make it queue-shaped.** Goals that shrink a list work best: failing tests, open issues, error traces, files to migrate, rows to process. A queue gives the agent a worklist and gives you a countable definition of done.
- **Lean on existing verification.** Tests, CI, type-checks, lint, eval suites, browser audits, and zero-match searches are leverage — they are what let a goal run unattended and still be trusted. If a task has no way to prove completion, help the user add one or reconsider whether goal mode fits.

Longer runs are not better runs. A tight contract that finishes in twenty turns beats an open-ended one that burns hours re-running the whole suite after every edit.

## Workflow

1. **Understand the intention.** Ask what outcome the user actually wants and what would prove it is done. If a finish line or a check is missing, that gap is the first thing to resolve together.
2. **Draft the goal.** Write a concrete objective in the user's language, covering as many parts of the contract above as the task warrants. Keep it readable — one or a few sentences for simple work, a short structured block (end state, checks, boundaries, stop rule) for larger work.
3. **Show it and explain.** Present the draft in full and walk through the choices: what you picked as the finish line, what proves it, what you fenced off, when it stops. Point out anything still soft.
4. **Revise together.** Take the user's edits and produce a new draft. Repeat until they are satisfied. If they want it looser than you would recommend, say so once, then write their version.
5. **Start it.** Once the user approves the wording, start the goal by calling `CreateGoal` with the agreed objective (and a `completionCriterion` if you settled on one). Do not just print the text for the user to paste, and do not start before they have approved. Starting still surfaces a final confirmation, so the user keeps the last word on whether it runs.

## A reusable shape

For a non-trivial goal, this fill-in-the-blanks structure covers the contract:

```
<What must become true.>
Done when <command/search/state that proves it>.
Scope: only <files/area>; do not <off-limits action>.
Loop: <how to iterate — rerun the check after each change, etc.>.
If <blocking condition>, stop and report instead of forcing a pass.
Stop after <N> turns and summarize what remains.
```

Not every goal needs every line. A small, well-scoped task can be a single clear sentence. Add structure as the work grows or the cost of a wrong autonomous run rises.

## Weak to strong

- Weak: `Find all bugs in this codebase.` — no finish line, no proof, no stop. The agent may block at once or run far past what you wanted.
  Strong: `Fix every test in test/auth that currently fails, rerun npm test until it exits 0, change no file outside test/ or src/auth, and stop after 20 turns with a summary of anything still failing.`
- Weak: `Optimize the project.` — no scope, no measure.
  Strong: `Migrate the payment module to the new API, make npm test -- payment exit 0, keep the diff limited to payment-related files, and stop and ask before touching shared infrastructure.`
- Weak: `Make it faster.`
  Strong: `Make renderFrame at least 3x faster measured by the bench/render benchmark; if you cannot reach 3x after several attempts, report the best result and why.`

## Common mistakes

| Mistake | Better |
| --- | --- |
| Starting or suggesting a goal the user did not ask for | Only draft a goal once the user asks; mention the option at most once otherwise |
| Drafting in English when the user is writing in another language | Match the user's language (or the project / memory preference) |
| Running the goal before the user has seen the exact text | Show the full draft and get agreement first |
| Polishing the goal silently against the user's stated wishes | Note the trade-off once, then write the goal they asked for |
| Specifying effort ("keep improving X") | Specify proof ("done when check X passes") |
| No stop or blocked path | Add a turn/budget cap and an explicit "stop and report" rule |
| A goal with no way to verify completion | Anchor it to tests, a search, a metric, or another inspectable check |
