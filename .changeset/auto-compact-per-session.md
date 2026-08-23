---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add per-session auto-compaction thresholds: the accepted `[loop_control] compaction_trigger_ratio` range widens from 0.5-0.99 to 0.25-0.99, and a new `/compact-threshold [<ratio>|off]` slash command (v2 engine) overrides the global config value for the current session only — like picking a session model while the default stays configured. The SDK exposes `Session.setCompactionTriggerRatio(ratio?)` and new optional `SessionStatus.compactionTriggerRatio` / `compactionTriggerRatioOverridden` read-back fields.