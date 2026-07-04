---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add experimental progressive tool disclosure (`select_tools`). When the `tool-select` experimental flag is on and the active model declares the `select_tools` capability, MCP tool schemas stay out of the request's top-level `tools[]` (preserving the provider prompt cache); the model loads tools on demand by exact name via the new built-in `select_tools` tool, guided by `<tools_added>/<tools_removed>` announcements. Off by default and inert on models without the capability — behavior is unchanged until a supporting model is catalogued. The SDK additionally maps the `select_tools` capability when building model aliases from a catalog and reports the new flag through `getExperimentalFeatures()`.
