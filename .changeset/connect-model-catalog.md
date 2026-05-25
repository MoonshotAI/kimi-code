---
"@moonshot-ai/kosong": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add a `/connect` command that configures a provider and model from a model catalog. By default it reads the catalog from models.dev and fills in model metadata (context window, output limit, and capabilities) automatically, so models no longer need to be written by hand in config. Pass `--url` to point at a custom catalog endpoint that uses the same format. When connecting an Anthropic-compatible provider whose catalog base URL already includes a version segment, the request path no longer duplicates that segment, so connections that previously failed with a not-found error now succeed.

When the network is unavailable, the CLI falls back to a pruned catalog snapshot that is inlined at build time, so the `/connect` command can still be used offline.
