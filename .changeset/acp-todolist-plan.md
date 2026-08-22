---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix ACP `plan` updates never being emitted for TodoList calls on the v2 engine: the v2 TodoList tool now attaches the `todo_list` input-display block to its execution, so `kimi acp` sends a `plan` session update whenever the agent reads or updates its todo list (previously the display was never attached, so the plan mapping in the ACP adapter could never fire).
