---
"@moonshot-ai/kimi-code": patch
---

Fix sessions created by newer builds failing to open in older CLI builds on the same machine; new sessions are written in a compatible layout, and existing sessions are healed on first open.
