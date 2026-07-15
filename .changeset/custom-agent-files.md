---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/kimi-code": minor
---

Add custom agents defined as Markdown files with frontmatter (custom or appended system prompt, tool allow/deny lists), discovered from user and project `agents/` directories, with `--agent` / `--agent-file` to select the main agent. Requires the v2 engine: `KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p --agent <name>`.
