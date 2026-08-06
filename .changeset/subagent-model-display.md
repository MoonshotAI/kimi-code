---
'@moonshot-ai/kimi-code': patch
---

Surface the bound model on subagent UIs. The `subagent.spawned` event now carries the display-normalized model alias (the derived `__secondary__` entry resolves to its base alias) and the child's effective thinking effort, so the TUI subagent card, swarm panel header, and background-agent entry show them at spawn instead of waiting for the child's first status frame — the effort only when it diverges from the session's; the WS snapshot roster and REST `/tasks` (background/detached subagents) also carry both, keeping them visible across client reconnects.
