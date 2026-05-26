---
"@moonshot-ai/kosong": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add a `/connect` command that configures a provider and model from a model catalog. The default catalog is bundled with the CLI, so `/connect` works offline; pass `--refresh` to fetch the latest catalog from models.dev, or `--url` to point at a custom catalog. Model metadata (context window, output limit, capabilities) is filled in from the catalog, so models no longer need to be written by hand in config.
