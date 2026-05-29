---
"@moonshot-ai/agent-core": minor
---

Add an experimental feature-flag system: a central registry (`flags/registry.ts`) plus an env-driven resolver. Gate a feature with `flags.enabled('id')`, toggled via `KIMI_CODE_EXPERIMENTAL_<NAME>` or the `KIMI_CODE_EXPERIMENTAL_FLAG` master switch. No flags are defined yet.
