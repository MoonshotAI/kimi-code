---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
---

Load `CLAUDE.md` as a fallback when discovering project/user memory. `AGENTS.md`/`agents.md` still take priority in each directory; `CLAUDE.md` is only read when neither exists, so repositories that already use Claude Code's `CLAUDE.md` work without maintaining a duplicate `AGENTS.md`.
