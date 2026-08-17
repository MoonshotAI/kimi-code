---
"@moonshot-ai/kimi-code": patch
---

Fix `kimi -p` refusing to start with an environment-supplied provider key: the auth readiness gate looked the vendor's declared `apiKeyEnv` up in the provider's `env` bag alone, so a key present only in the process environment was reported as `provider <id> has no credential configured` even though the adapter issuing the request would have read it. The gate now falls back to the process environment, with an explicit `[providers.<id>.env]` entry still taking precedence.
