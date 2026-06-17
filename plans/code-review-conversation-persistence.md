# Code Review — Conversation Persistence Problem

Status: **open, for discussion.** No code written for this yet.

## The problem

A completed `/review` produces **no conversation records and no LLM messages**.
The review output exists only as ephemeral TUI chrome plus a JSON file on disk.
As a result:

- **Resume is empty.** On reopen, the transcript is rebuilt from session records,
  which contain nothing about the review.
- **The agent can't see the review.** The main agent's conversation never
  contained it, so asking "fix these" / "can you see the review?" fails — the
  model genuinely has no record that a review happened.

## Why (root cause, verified in code)

The review runs **out-of-band from the agent's turn**:

- `/review` → `handleReviewCommand` → `session.startReview()` **directly over
  RPC**. It never goes through the main agent's turn, so it creates no
  user / assistant / tool message.
- `appendTranscriptEntry` (`kimi-tui.ts`) only pushes to the in-memory
  `state.transcriptEntries` and the live UI container. It does **not** write a
  session record.
- `session-replay.ts` reconstructs the transcript from record kinds: `message`,
  `compaction`, `goal_updated`, `plan_updated`, `permission_updated`,
  `approval_result`, `config_updated`. **There is no review record kind.**
- `ReviewInjector` (agent-core) injects review background/assignment context into
  the **reviewer sub-agent** during the review — not the main agent afterward.
- The artifact JSON under `<sessionDir>/reviews/…` is durable but is **not** a
  conversation record; neither the LLM nor replay reads it.

So after a review, the session's conversation is byte-for-byte what it was
before — the review contributed zero records.

## The key distinction

There are two kinds of session record, and only one is the model's context:

| Record kind | LLM sees it? | Persists + replays? |
| --- | --- | --- |
| conversation `message` (user/assistant/tool/system) | **yes** | yes |
| display/state (`goal_updated`, `plan_updated`, …) | no | yes (UI only) |

Consequence: a generic "durable review record" of the display kind would fix
resume *display* but the agent still would not see the review. **Only an actual
`message` record makes the agent see it** (and it persists + replays for free).

## Options (to decide tomorrow)

1. **Review as a tool call within a turn.** `/review` seeds a turn in which the
   main agent invokes a `review` tool; the orchestrator runs inside it and
   returns its result as a **tool-result message**. The result is in the
   conversation → LLM sees it, it persists, it replays. Matches how all other
   agent work is recorded. *Lean toward this.*
2. **Synthetic message injection.** Keep the direct RPC, but after completion
   write a synthetic assistant/system message (summary + artifact pointer) into
   the records. Simpler, but only the summary becomes native; the review work
   itself is still out-of-band, and it feels grafted on.
3. **Hybrid.** The slash command posts a real user message ("Review the working
   tree…") and the agent runs the review tool — a fully native turn
   (user → tool call → tool result → assistant summary).

## Open questions

- Turn/tool-call (1 or 3) vs. summary injection (2)?
- Does the user-visible trigger stay `/review`, or become a normal agent request?
- What goes into the conversation message: **pointer + counts** (agent reads the
  JSON on demand — smaller context) or the **full comment list inline** (agent
  always has them — more tokens)?
- How does the **colored compact block** relate to a conversation message —
  render a `message` record specially, or carry structured data alongside?
- Do the **rejection** records need to be conversation messages too (so "fix the
  rest" reflects them on resume), or is re-reading the JSON enough?
- Do the **reviewer sub-agent runs** need to appear in the conversation, or only
  the final result?

## Related design docs

- `code-review-presentation-design.md` — the presentation design (its
  "transcript records (SSOT)" + "fix path" sections were never implemented; this
  is that gap).
- `code-review-presentation-report.md` — what was built.
- `code-review-general-problems.md` — the trial feedback that surfaced this.
