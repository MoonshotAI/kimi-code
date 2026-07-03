---
"@moonshot-ai/kimi-code": patch
---

Enrich PATH from the user's login shell at startup, so shell commands find user-installed tools (e.g. Homebrew's `gh`) even when kimi-code was launched without the full profile PATH.
