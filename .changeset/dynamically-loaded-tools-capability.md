---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Rename the dynamic tool loading model capability to `dynamically_loaded_tools` (the model-level ability to accept message-level tool declarations). The previous `select_tools` spelling — which named the client-side mechanism rather than the model capability — is removed outright: no catalogued model or shipped configuration ever used it, so there is nothing to migrate. Model alias `capabilities` config, catalog entries, and the SDK's catalog-to-alias mapping all use the new name.
