---
"@moonshot-ai/agent-core": patch
---

Fix the Windows Bash tool for Git Bash: rewrite Windows-style backslash paths and `>nul` redirects, drop the cmd-only `cd /d` flag, add POSIX fallbacks for common missing commands, and neutralize the `MSYSTEM` value the Git Bash launcher injects so build tools detect the Windows MSVC environment instead of mingw before the command runs.
