---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/kimi-code": minor
---

Support custom agents defined as Markdown files with frontmatter — name, description, tool allow/deny lists, and a prompt body — discovered from user and project directories, usable as the main agent or a sub-agent (v2 engine only). Start one with `KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p --agent <name>` or `--agent-file <path>`; see "Custom Agents" in the Agents docs for the file format.
