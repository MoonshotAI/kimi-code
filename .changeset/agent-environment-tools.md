---
"@moonshot-ai/kimi-code": minor
---

The main agent can switch the session environment with `change_environment`, create a temporary environment with `connect`, and bind a subagent to an environment via the `Agent` tool's `environment` parameter. Enable with `KIMI_CODE_EXPERIMENTAL_AGENT_ENVIRONMENT_TOOLS=1` or `[experimental] agent_environment_tools = true` in `config.toml`.
