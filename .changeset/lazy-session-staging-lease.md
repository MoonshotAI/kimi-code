---
"@moonshot-ai/kimi-code": patch
---

Fix pasted images never reaching the model on the first message of a fresh session: lazy session creation released the submission's staging lease and deleted the upload before the engine could read it.
