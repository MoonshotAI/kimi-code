---
"@moonshot-ai/kimi-code": patch
---

Apply provider model refreshes as a single atomic config commit, so requests landing during a refresh no longer fail with transient model-resolution errors and sessions created mid-refresh no longer permanently lose the WebSearch tool.
