---
'@moonshot-ai/agent-core-v2': patch
---

Restore an agent's recorded initial tool baseline verbatim from its session journal when resuming instead of recomputing or re-filtering it against the current environment, preserving inherited subagent baselines without duplicate writes for unchanged baselines. Older sessions without a recorded baseline still derive it from their initial tool catalog under their session policy, and disabled tools remain blocked at execution time.
