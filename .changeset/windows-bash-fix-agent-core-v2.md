---
"@moonshot-ai/agent-core-v2": patch
---

Apply the same Windows Git Bash command pre-processing to the v2 Bash tool: rewrite Windows-style backslash paths and `>nul` redirects, drop the cmd-only `cd /d` flag, add POSIX fallbacks for common missing commands, and neutralize the `MSYSTEM` value the Git Bash launcher injects so build tools detect the Windows MSVC environment instead of mingw before the command runs.
