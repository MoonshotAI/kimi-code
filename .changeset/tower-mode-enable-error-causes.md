---
"@moonshot-ai/kimi-code": patch
---

The error shown when tower mode cannot be enabled now tells the causes apart: the tower experiment is disabled (set `KIMI_CODE_EXPERIMENTAL_TOWER=1` and restart), another live session owns the workspace tower, or the toggle addressed a non-main agent.
