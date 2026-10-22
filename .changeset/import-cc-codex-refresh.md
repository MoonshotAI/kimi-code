---
"@moonshot-ai/kimi-code": patch
---

`/import-from-cc-codex` now follows the current Claude Code and Codex layouts: it honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, imports project `CLAUDE.md`, `CLAUDE.local.md`, Claude rules, Codex `AGENTS.override.md`, and Claude project-local MCP servers, and no longer scans `.claude/AGENTS.md`, `.codex/AGENTS.md`, or `.codex/skills`.
