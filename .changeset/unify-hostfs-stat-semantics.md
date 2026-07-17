---
"@moonshot-ai/kimi-code": patch
---

Align the web backend's file stat semantics with the CLI: stat now follows symbolic links by default, with explicit lstat only where symlink detection is intended; unreadable AGENTS.md files now surface a warning instead of being skipped silently.
