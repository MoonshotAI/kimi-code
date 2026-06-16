---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kosong": patch
---

Isolate the Anthropic adapter from ambient shell credentials.

The adapter is used as a generic transport to *any* anthropic-compatible endpoint (`baseUrl` may point at a third-party gateway). The underlying Anthropic SDK, however, auto-discovers credentials from the shell environment by default. When the endpoint is not official this leaks: even with an explicit API key configured, the SDK would still read `ANTHROPIC_AUTH_TOKEN` from the environment and attach it as an `Authorization: Bearer` header — sending an out-of-band token (often injected by another tool, unbeknownst to the user) to the third-party `baseUrl`. The adapter now hard-disables every SDK environment auto-discovery channel (`authToken`, `baseURL`, custom headers) and uses only host-provided credentials.

**Behavior change:** the adapter no longer reads `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS` from the shell. Configure credentials through provider config (`apiKey` or `[provider.env]`) instead.
