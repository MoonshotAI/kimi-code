---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

Import previously unsupported vendors from the models.dev catalog: providers whose SDK is not explicitly recognized now fall back to the OpenAI-compatible wire (with a visible "guessed" note) instead of being refused, and imports that lack a usable endpoint ask for one — `--base-url` on the CLI, a prompt in the TUI. Truly proprietary SDKs (Amazon Bedrock) and env-placeholder URLs are still refused with a clear reason.
