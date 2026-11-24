---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/klient": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/acp-server": patch
---

Introduce surface-scoped `experimental` / `beta` / `ga` flag stages, non-destructive `[experimental].beta` master resolution, `experimental_beta` and `experimental_features` fields on `GET /api/v1/meta`, and one-time startup migration for existing `KIMI_CODE_EXPERIMENTAL_FLAG=1` `tower` setups; `wait_for` now defaults to disabled unless enabled via `[experimental] wait_for = true` or `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`.
