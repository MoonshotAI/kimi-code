---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/klient": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/acp-server": patch
---

Introduce surface-scoped `experimental` / `beta` / `ga` flag stages and profile-isolated `[experimental.cli]` / `[experimental.desktop]` config buckets (with legacy flat `[experimental]` TOML normalization), register `context_inspector`, `session_mentions`, and `sidebar_multi_tab` alongside canonical `notify_user` for desktop and web surfaces, add non-destructive `beta` master resolution, expose `experimental_beta` (including `profile`) and `experimental_features` on `GET /api/v1/meta`, and add one-time startup migration for existing `KIMI_CODE_EXPERIMENTAL_FLAG=1` `tower` setups; `wait_for` now defaults to disabled unless enabled via `[experimental.cli] wait_for = true` or `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`.
