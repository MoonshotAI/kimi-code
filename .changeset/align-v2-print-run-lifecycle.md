---
"@moonshot-ai/kimi-code": patch
---

Align `kimi -p` on the experimental engine with the default engine's run lifecycle: the print background policy now defaults to steer with no practical turn or time cap, background task and per-turn step limits are lifted unless configured, and the run stays alive while cron tasks still have future fires so their steered turns can run.
