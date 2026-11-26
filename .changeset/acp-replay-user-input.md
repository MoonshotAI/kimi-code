---
"@moonshot-ai/acp-server": patch
---

`session/load` replays as user messages only what the user typed: reminders, compaction summaries, hook results and other notices the product added to the context are left out, UserPromptSubmit hook output and bundled skill text are stripped from a prompt, and a slash skill or plugin command replays as `/name args` followed by any text the user attached, using the command name the session advertises for that skill (so a sub-skill replays under its bare name). A shell command run in the terminal UI replays as `$ command` followed by its output in a code block, instead of the raw `<bash-input>` and `<bash-stdout>` text. Replayed file tool calls carry `locations`, resolved against the session's own working directory when the recorded path is relative; a path starting with `~` or a `kimi-file://` attachment URI gets no location.
