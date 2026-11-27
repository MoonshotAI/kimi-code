---
"@moonshot-ai/remote-control": patch
---

Release held Remote Control machine locks synchronously on process exit when the on-disk lock nonce still matches, and unregister the exit listener once all locks are released.
