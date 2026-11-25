---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/agent-core-v2": patch
---

Expose `GET /api/v1/tools/catalog`, map global `[tools]` in the config API, and report Plan, Swarm, Tower, and Goal mode availability in agent frames, refreshing frames when global `[tools]` or session tool policy changes. Enforce the required tools when entering Plan, Swarm, Tower, or autonomous Goal modes while keeping mode exit and Goal pause/cancel available.
