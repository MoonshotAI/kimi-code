---
"@moonshot-ai/kimi-code": patch
---

Decouple provider and model management from config persistence on the experimental engine: the runtime keeps its own provider/model registry, and a dedicated sync layer hydrates it from config.toml at startup and writes runtime changes (added providers, discovered models, default-model selection) back to disk.
