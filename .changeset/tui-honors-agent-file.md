---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": minor
---

Bind the agent selected by `--agent` or `--agent-file` to the startup session of the interactive TUI, which previously started on the default agent without reporting that the flag was dropped. An `--agent-file` is registered for the whole launch while the flag itself still binds only the startup session, so a file named after a built-in agent keeps replacing that built-in for sessions created later in the same launch. A requested name absent from the workspace agent catalog is now rejected before the session is created instead of after. The SDK gains a matching `agentFiles` harness option.
