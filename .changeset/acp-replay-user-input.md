---
"@moonshot-ai/acp-server": patch
---

`session/load` replays as user messages only what the user typed: reminders, compaction summaries, hook results and other notices the product added to the context are left out, UserPromptSubmit hook output and bundled skill text are stripped from a prompt, and a slash skill or plugin command replays as `/name args` followed by any text the user attached. Replayed file tool calls carry `locations`, resolved against the session's own working directory when the recorded path is relative; a path starting with `~` gets no location.
