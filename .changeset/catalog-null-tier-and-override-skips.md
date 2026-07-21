---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

Align catalog imports with the reference models.dev consumer: a JSON `null` entry in declared effort values is now read as the `none` off-encoding (previously such models were wrongly treated as always-thinking), alpha-status models are filtered out alongside deprecated ones, and models whose per-model provider override targets a protocol that cannot be expressed (e.g. Claude models on google-vertex, gpt models on an Anthropic provider) are skipped instead of being imported under the silently wrong wire.
