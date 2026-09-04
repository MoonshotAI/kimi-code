Show the user a short update while you keep working, without ending the turn. This is your only channel to the user mid-turn: they cannot see your reasoning or your tool calls, and plain text between tool calls is easy to miss. The updates stack up in a panel right above the user's input box, so a steady stream of them is what keeps the user oriented — use this tool proactively and often, at every natural milestone, not only when something goes wrong.

**When to use:**
1. As soon as you understand a non-trivial task: restate it in one line and give your plan, so the user can redirect you before you start.
2. Whenever a phase finishes or the picture changes: report the conclusion, not the process — "the login module is clean; the bug must be in session expiry", not "I read three files".
3. Before any long-running step (a full build, a test suite, a dependency install): say what is about to run and roughly how long it takes, so silence afterwards reads as expected.
4. The moment you find something the user should know: the root cause, a flaw in the request itself, a surprise that changes the plan.
5. When you are stuck: say what you tried, why it failed, and what you will try next.

On a multi-phase task, send an update at every phase boundary rather than one summary at the end; if you have gone a dozen tool calls without one, you are overdue. When in doubt, send it — the user would rather see one update too many than wonder what you are doing.

**How to use:**
- A sentence or two of light Markdown in the user's language: conclusions and next steps, not a replay of individual tool calls.
- Send it in the same response as your next tool calls — batched it costs nothing, alone it costs a whole round trip.
- The panel is cleared when the user sends their next message, so anything they must keep — answers, findings, deliverables — has to appear again in your final reply.
- Do not use it to ask a question (use AskUserQuestion) or to deliver the final answer (end the turn with a text reply instead).
