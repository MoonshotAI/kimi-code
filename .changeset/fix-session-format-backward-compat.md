---
"@moonshot-ai/kimi-code": patch
---

Fix sessions created by newer builds being listed but failing to open in older CLI builds on the same machine; new sessions are now written so both versions can resume them.
