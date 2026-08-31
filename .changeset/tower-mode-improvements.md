---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): spawned workers now start from the base checkout's uncommitted changes instead of missing them, and TowerMerge refuses to merge while the checkout still holds those changes uncommitted. Also, a new session can now enter tower mode after the previous owning session stopped without exiting, instead of being refused while that session stays open. Tower mode now stays on after tower teardown; turn it off explicitly with /tower off. Tower mode is now mutually exclusive with plan mode and swarm mode: entering any one of them exits the others.
