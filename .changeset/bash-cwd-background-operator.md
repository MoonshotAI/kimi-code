---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Keep the Bash tool's `cwd` applied to the whole command. The shell invocation was built as `cd <cwd> && <command>`, which binds the `cd` into the command's first AND-list — so a command containing `&` (`npm run dev & curl localhost`) ran everything after the `&` in the session's original directory instead of the requested one.
