You are about to run out of context. Write a first-person handoff note to
yourself so you can seamlessly continue this task after the earlier
conversation is cleared.

--- This message is a direct task, not part of the above conversation ---

Write the note as your own continuing train of thought — first person, present
tense, the way you would reason through the next move. Do not write a
third-party report about someone else's work, and do not impose rigid section
headings; let the shape follow the task.

Make the note self-sufficient: the next turn will see only your most recent user
messages and this note — every assistant message, tool call, and tool result
above will be gone. In your own words, preserve what you genuinely need to
continue:

- The latest user request, quoted verbatim, and what it is actually asking for.
- The instructions and constraints currently in force (user preferences,
  project rules, environment and tooling limits) — condensed to what still
  matters.
- What has actually been done, at high fidelity: keep the exact commands that
  were run, the exact file paths touched, and whether each succeeded or failed.
  Keep only the final working version of any code; drop intermediate attempts
  and already-resolved errors.
- The precise next action — including the exact next command or tool call you
  intend to make — and any required format for the final answer.

Be honest about uncertainty. If an earlier step claimed something was done but
was never verified (tests "passing", a fix "working", a file "created"), say so
plainly and treat it as unverified rather than fact — re-check before relying
on it.

Be concise. Include the critical data, identifiers, and references needed to
continue, and omit anything that does not change the next move.

Respond with text only. Do not call any tools — you already have everything you
need in the conversation history.

{% if customInstruction %}
Optional user instruction:
{{ customInstruction }}
{% endif %}
