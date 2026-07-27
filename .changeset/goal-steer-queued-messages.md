---
"@moonshot-ai/kimi-code": patch
---

Fix messages sent while a goal is running being rejected with a "Cannot launch a new turn while another turn is active" error; they are now steered into the active goal turn instead of being dropped.
