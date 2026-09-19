---
"@moonshot-ai/kimi-code": minor
---

The main agent now gets environment tools by default: switch the session environment with `change_environment`, create a temporary environment with `connect`, and bind a subagent to an environment via the `Agent` tool's `environment` parameter. Disable with `KIMI_CODE_EXPERIMENTAL_AGENT_ENVIRONMENT_TOOLS=0` or `[experimental] agent_environment_tools = false` in `config.toml`.
