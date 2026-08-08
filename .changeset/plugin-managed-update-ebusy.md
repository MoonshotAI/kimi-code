---
"@moonshot-ai/kimi-code": patch
---

Fix managed plugin updates failing with EBUSY on Windows by rename-swapping the live directory instead of deleting it in place.
