---
"@moonshot-ai/kimi-code": patch
---

Hook commands that use a `~` path (for example `python3 ~/hooks/check.py`) now work on Windows. The literal `~` was previously handed to `cmd.exe`, which has no tilde concept and resolved it against the working directory, so the hook failed to start — and because a failed `PreToolUse` hook blocks the tool call it guards, one `~` in a hook path silently disabled every tool call in the session. A `~` inside an argument, such as `--flag=a~/b`, keeps its literal meaning.
