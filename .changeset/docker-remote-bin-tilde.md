---
"@moonshot-ai/kimi-code": patch
---

Fix docker remote environments failing their first connect attempt and showing a misleading install prompt with the default executor path — the `~` in `remoteBin` is now resolved to the container user's home before connecting.
