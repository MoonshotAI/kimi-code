---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Fix a skill with a `SKILL.md` that fails to parse (e.g. invalid frontmatter) being dropped from the skill list with no signal. A session-start warning now names the skill file and the reason it was not loaded, in both the CLI/TUI engine and `kimi web`/print mode.
