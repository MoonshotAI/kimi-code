---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

Unify catalog import resolution into a single decision function: wire-type inference, the OpenAI-compatible fallback, proprietary-SDK refusal, endpoint adaptation, and the base-URL requirement are now produced together by one pure resolver consumed by both the CLI and the TUI, replacing a set of cooperating predicates. No behavior change.
