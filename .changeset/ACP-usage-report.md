---
'@moonshot-ai/kimi-code': patch
---

ACP: emit `usage_update` session frames. After every turn and on session open (new/load/resume) the adapter now pushes the stable `usage_update` update with `used`/`size` from the engine's session status, so ACP clients can render context occupancy without waiting for the first prompt. When the session's provider is the managed Kimi platform, the account quota (5-hour window, weekly summary, booster balance from `/usages`, fetched at most once a minute) rides along as `_meta.kimiCode.rateLimits`; clients that do not read `_meta` see an ordinary usage frame.
