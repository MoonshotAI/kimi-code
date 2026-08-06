---
'@moonshot-ai/kimi-code': patch
---

Surface the bound model on subagent UIs. The `subagent.spawned` event now carries the display-normalized model alias (the derived `__secondary__` entry resolves to its base alias), so the TUI subagent card, swarm panel header, and background-agent entry show the model at spawn instead of waiting for the child's first status frame; the WS snapshot roster and REST `/tasks` (background/detached subagents) also carry it, keeping the model visible across client reconnects.
