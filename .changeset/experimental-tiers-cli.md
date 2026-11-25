---
"@moonshot-ai/kimi-code": minor
---

Promote `/lab` as the primary Lab command (keeping `/experiments` and `/experimental` as aliases), split Lab into `Beta` and `Experimental` tiers with an `Enable all Beta features` switch, graduate `NotifyUser` to be enabled by default in CLI, and stop enabling `WaitFor` or `Experimental`-tier flags by default or via `KIMI_CODE_EXPERIMENTAL_FLAG=1`; enable `WaitFor` in `/lab`, `[experimental] wait_for = true`, or `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`.
