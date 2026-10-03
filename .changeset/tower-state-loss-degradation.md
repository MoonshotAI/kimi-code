---
"@moonshot-ai/kimi-code": minor
---

Tower mode (experimental) now degrades gracefully when .tower/comms is accidentally deleted: TowerStatus reports the state loss instead of failing, TowerSend/TowerComplete recover a minimal state stamped recoveredAt and keep delivering messages, and TowerMerge/TowerRebase refuse with an explicit state-lost error.
