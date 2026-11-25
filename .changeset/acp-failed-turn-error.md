---
"@moonshot-ai/acp-server": patch
---

A turn that fails after it has started now answers `session/prompt` with a JSON-RPC error instead of the `end_turn` stop reason. Authentication failures still return `authRequired`; other failures return code `-32603` with the error message and the error code in `data.code`. A response blocked by the provider's content filter still ends with `refusal`, and a turn that fails after `session/cancel` now ends with `cancelled`.
