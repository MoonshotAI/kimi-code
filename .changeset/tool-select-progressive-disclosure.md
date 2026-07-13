---
"@moonshot-ai/kimi-code": minor
---

Port progressive tool disclosure to the new agent engine: MCP tool schemas stay out of the top-level tool list, and the model loads them by name on demand through the announcements plus the select_tools tool, keeping the prompt cache stable. Off by default; set KIMI_CODE_EXPERIMENTAL_TOOL_SELECT=1 to enable.
