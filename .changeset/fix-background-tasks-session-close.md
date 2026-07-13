---
"@moonshot-ai/kimi-code": patch
---

Stop background tasks on session close so their processes no longer leak while the server keeps running, honoring the keepAliveOnExit opt-out and the killGracePeriodMs stop grace.
