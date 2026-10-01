---
"@moonshot-ai/kimi-code": patch
---

Fix the latest reply disappearing from the transcript after a background task completion notification arrives; the fold boundary is now anchored to the notification turn itself instead of the asynchronously mounted task card.
