---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): spawned workers now start from the base checkout's uncommitted changes instead of missing them, and TowerMerge refuses to merge while the checkout still holds those changes uncommitted. Also, a new session can now enter tower mode after the previous owning session stopped without exiting, instead of being refused while that session stays open.
