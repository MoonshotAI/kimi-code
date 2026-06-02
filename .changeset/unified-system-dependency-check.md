---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kaos": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add a unified system-dependency check for ripgrep, fd, and the shell. Kimi Code CLI now starts on Windows even when Git Bash is missing (the Bash tool is omitted and the model is told why, instead of the CLI crashing), warns at startup when `fd` is unavailable outside a git repository, and reports the health of all three external tools in `/status`. Dependency metadata lives in a single declarative registry so detection and messaging stay consistent.

BREAKING: the now-unused `KaosShellNotFoundError` (`@moonshot-ai/kaos`) and `ErrorCodes.SHELL_GIT_BASH_NOT_FOUND` (`@moonshot-ai/agent-core`, re-exported by `@moonshot-ai/kimi-code-sdk`) are removed, since a missing shell is no longer a hard failure.
