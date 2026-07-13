---
"@moonshot-ai/agent-core-v2": patch
---

Fix v2 managed OAuth login ignoring `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST`: the login environment is now resolved env-aware (v1 parity), so the credential slot a token is written to always matches the slot the runtime reads — no more "login succeeds but every call 401s" against non-default environments. The provisioned provider entry records the login environment and credential slot explicitly, and logout deletes from the runtime (env-aware) slot.
