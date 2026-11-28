---
"@moonshot-ai/kimi-code-sdk": minor
---

Replace single-tier experimental flag defaults with per-surface `experimental` / `beta` / `ga` stages, profile-isolated `[experimental.cli]` / `[experimental.desktop]` config buckets, effect-timing metadata, `getExperimentalBetaState()`, and one-time `KIMI_CODE_EXPERIMENTAL_FLAG=1` startup migration for `tower`; `WaitFor` is no longer enabled by default unless configured via `[experimental.cli] wait_for = true` or `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`.
