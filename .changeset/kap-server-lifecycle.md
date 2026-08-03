---
"@moonshot-ai/kap-server": patch
---

Define and enforce shutdown ordering: stop HTTP intake, quiesce active sessions (drain all agents), then perform bounded telemetry flush, then dispose core scope and release instance registration. Partial-boot failure paths are covered by the existing close() rollback.
