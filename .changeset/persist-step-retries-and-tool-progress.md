---
"@moonshot-ai/agent-core": patch
---

Persist recovered step retries and a bounded tool-progress summary to the agent record wire. `step.end` now carries an optional `retries` array (the transient provider failures recovered before the step succeeded — previously only emitted as the live-only `step.retrying` event), and `tool.result` carries an optional `progress` summary (`updateCount` / `lastStatus` / `maxPercent`, excluding streamed stdout/stderr). Both are additive optional fields, so the wire protocol version is unchanged and old records keep loading.
