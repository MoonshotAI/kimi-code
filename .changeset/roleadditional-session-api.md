---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add a `roleAdditional` option to the session API. The agent profile system already renders a `{{ROLE_ADDITIONAL}}` slot, but there was no way to set it through the SDK — the render half existed with no input path. `createSession` / `resumeSession` now accept an optional `roleAdditional` string that is threaded (parallel to `additionalDirs`) into the resolved profile's system prompt for every agent in the session. When resume or reload supplies a `roleAdditional` that differs from the value that rendered an agent's persisted prompt, that agent's system prompt is re-rendered from the restored profile; an omitted value preserves the persisted standing prompt (so `Session.reloadSession()` / `/reload`, which cannot pass one, no longer clears it), while an explicit empty string clears it. Additive and optional — no behavior change when unset.
