---
"@moonshot-ai/kimi-code": minor
---

Add experimental remote runtimes: declare SSH hosts, Docker containers, or custom launcher commands in the `[runtimes]` config section (or a trusted project's `.kimi-code/runtimes.toml`) so agent tools can execute in the target environment. Enable with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`.
