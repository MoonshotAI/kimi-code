---
"@moonshot-ai/kimi-code": patch
---

Stop forwarding the host identity headers (including X-Msh-Device-Id) to kimi-typed providers whose endpoint is not the first-party Moonshot host, so a Kimi-compatible proxy or gateway no longer receives the device identity set.
