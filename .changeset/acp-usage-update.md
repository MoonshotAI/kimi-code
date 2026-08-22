---
"@moonshot-ai/kimi-code": patch
---

Forward context-window usage over ACP as `usage_update` session updates ({used, size}, deduped per turn), so ACP clients can render a live context gauge — previously context usage was only visible in the interactive TUI and the `/status` slash text.
