---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/kimi-code": minor
---

Support custom agents defined as Markdown files with frontmatter — a system-prompt body rendered as a template with `${var}` context variables and `${base_prompt}` for wrapping the default prompt, plus tool allow/deny lists — selected via `--agent <name>` / `--agent-file <path>` (v2 engine only: `KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p`). See "Custom Agents" in the Agents docs for the file format, discovery directories, and binding semantics.

Fix resuming a session in the v1 engine when its wire log contains a `tools.set_active_tools` record without `names` (written by v2-engine sessions): such records no longer crash replay.
