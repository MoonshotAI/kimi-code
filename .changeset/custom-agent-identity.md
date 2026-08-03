---
"@moonshot-ai/kimi-code": minor
---

Add a custom agent identity: the new `[identity]` section in `config.toml` (`name`, optional `slug`, also settable via `KIMI_CODE_IDENTITY_NAME` / `KIMI_CODE_IDENTITY_SLUG`) sets the name the agent calls itself in the system prompt, the `User-Agent` product token sent to third-party providers, and the client name announced to MCP servers.

Add a `builtin_product_skills` field (also settable via `KIMI_CODE_BUILTIN_PRODUCT_SKILLS`) that controls whether the built-in skills documenting Kimi Code itself — `update-config`, `custom-theme`, `mcp-config`, `check-kimi-code-docs`, `import-from-cc-codex` — are offered to the model. Enabled by default; turning it off trims their names and descriptions from the system prompt.
