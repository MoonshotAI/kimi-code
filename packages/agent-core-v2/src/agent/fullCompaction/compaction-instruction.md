You are performing a context compaction. The conversation above is about to be
cleared to free up context; what carries forward is the user's own messages
(kept verbatim, but size-capped, so a long message may be truncated) and the
summary you write here.

--- This message is a direct task, not part of the above conversation ---

Write a structured handoff summary of the conversation so far, paying close
attention to the user's explicit requests and your previous actions. Write it
as neutral work notes about the task — not as a first-person letter to
yourself, not as a message to anyone. Write in the same language the
conversation has been using — do not switch to English just because these
instructions happen to be in English.

Scope the summary to the conversation itself:

- Your system prompt remains in force unchanged and is re-sent separately
  after compaction. Do NOT restate, transcribe, or paraphrase it.
- Record the constraints and preferences the user explicitly stated in the
  conversation. Scoped project rules that exist only in the conversation
  (for example, a subdirectory AGENTS.md read earlier) are NOT re-sent:
  keep the ones that still matter, noting their source paths.
- Do not mention this summarization request or that compaction happened.

Cover what genuinely matters for continuing the work:

1. Primary request and intent: what the user is actually asking for, including
   any ambiguity you have already resolved. The kept user messages are
   size-capped, so if the latest request is large (a big paste or file),
   preserve the parts at risk of being dropped — above all the actual ask. If
   several requests are in play, say which one governs the next move, and
   re-quote any still-relevant earlier request that may have scrolled out of
   the kept messages.
2. User-stated constraints and preferences: only what the user said in the
   conversation — keeping decisions already settled (what was chosen and why)
   separate from questions still open, so a closed choice is not silently
   reopened and an undecided point is not treated as decided.
3. What has actually been done, at high fidelity: the exact commands that were
   run, the exact file paths touched, and whether each succeeded or failed —
   and the results themselves, not just the commands: the concrete values
   returned, the key lines or error text, the schema or signature a lookup
   revealed, since re-running to recover them may be slow or impossible. Keep
   only the final working version of any code; drop intermediate attempts and
   already-resolved errors.
4. Errors and user feedback: errors that were run into and how they were
   fixed — especially where the user said to do something differently.
5. What is still unknown: context the next step depends on that this
   conversation never established — files or paths referenced but not yet
   read, schemas or APIs assumed but unseen, questions the user has not
   answered. Name these gaps so the next turn checks them instead of assuming.
6. Current work and next step: precisely what was being done immediately
   before this request, and the remaining sequence to finish — the exact next
   command or tool call, the decisions already made for upcoming steps (so
   they are not reopened), the obstacles or edge cases you can already foresee
   and how to handle them, and any required format for the final answer. Quote
   the most recent conversation verbatim where it pins down exactly what was
   being worked on and where things were left off.

Your TODO list is re-attached automatically after compaction from its live
source, so do not transcribe it — copying it wastes space and can contradict
the live version. What that list cannot hold is the reasoning between tasks —
why one was reordered or dropped, or a decision on one that constrains another
— so record that instead.

Be honest about uncertainty. If an earlier step claimed something was done but
was never verified (tests "passing", a fix "working", a file "created"), say
so plainly and treat it as unverified rather than fact — re-check before
relying on it.

Be concise, and keep the summary proportional to the task: a long multi-step
task warrants detail, but a trivial or nearly finished exchange needs only a
sentence or two — do not pad it out. Include the critical data, identifiers,
and references needed to continue, and omit anything that does not change the
next move.

Respond with text only. Do not call any tools — you already have everything
you need in the conversation history.
${custom_instruction_block}