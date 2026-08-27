You are about to run out of context. Write a first-person handoff note to
yourself so you can seamlessly continue this task after the earlier
conversation is cleared.

--- This message is a direct task, not part of the above conversation ---

Write the note as your own continuing train of thought — first person, present
tense, the way you would reason through the next move. Do not write a
third-party report about someone else's work, and do not impose rigid section
headings; let the shape follow the task. Write the note in the same language the
conversation has been using — do not switch to English just because these
instructions happen to be in English.

Make the note self-sufficient: the next turn will see only your most recent user
messages and this note — every assistant message, tool call, and tool result
above will be gone. In your own words, preserve what you genuinely need to
continue:

- What the latest request is actually asking for: your reading of its intent and
  any ambiguity you have already resolved — not a re-transcription, since what
  fits is kept verbatim in your most recent messages. But those kept messages are
  size-capped, so a long request is truncated there: if the latest request is
  large (a big paste or file), preserve the parts at risk of being dropped —
  above all the actual ask. If several requests are in play, say which one governs
  the next move, and re-quote any still-relevant earlier request that may have
  scrolled out of the kept messages.
- The instructions and constraints currently in force (user preferences,
  project rules, environment and tooling limits) — condensed to what still
  matters, keeping decisions you have already settled (what you chose and why)
  separate from questions still open, so you neither silently reopen a closed
  choice nor treat an undecided point as decided.
- What has actually been done, at high fidelity: keep the exact commands that
  were run, the exact file paths touched, and whether each succeeded or failed —
  and the results themselves, not just the commands: the concrete values
  returned, the key lines or error text, the schema or signature a lookup
  revealed, since re-running to recover them may be slow or impossible. Keep only
  the final working version of any code; drop intermediate attempts and
  already-resolved errors.
- What you still don't know: context the next step depends on that this
  conversation never established — files or paths referenced but not yet read,
  schemas or APIs assumed but unseen, questions the user has not answered. Name
  these gaps so the next turn goes and checks them instead of assuming.
- The forward plan — and this is the moment to invest in it. Right now you
  hold more context on this task than you ever will again; the next turn
  resumes with less, so the plan you commit here is the one it will follow.
  Give the exact next command or tool call, but don't stop at the next step:
  set out the remaining sequence to finish, the decisions you have already
  made for those upcoming steps (so the next turn doesn't reopen them), the
  obstacles or edge cases you can already foresee and how you mean to handle
  them, and any work you can commit to now — the exact patch, query, or shape
  of the final answer you already know you will produce. Anything you settle
  here is one less thing the next turn must rediscover. Include any required
  format for the final answer.

Your TODO list is re-attached automatically below this note from its live
source, so do not transcribe it — copying it wastes space and can contradict the
live version. What that list cannot hold is the reasoning between tasks — why one
was reordered or dropped, or a decision on one that constrains another — so
record that instead.

Be honest about uncertainty. If an earlier step claimed something was done but
was never verified (tests "passing", a fix "working", a file "created"), say so
plainly and treat it as unverified rather than fact — re-check before relying
on it.

Be concise, and keep the note proportional to the task: a long multi-step task
warrants detail, but a trivial or nearly finished exchange needs only a sentence
or two — do not pad it out. Include the critical data, identifiers, and
references needed to continue, and omit anything that does not change the next
move.

Respond with text only. Do not call any tools — you already have everything you
need in the conversation history.

${custom_instruction_block}
