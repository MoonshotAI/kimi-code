---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Rename the experimental remote-runtime surface to environments: the `[environments]` config section (was `[runtimes]`), `.kimi-code/environments.toml` (was `runtimes.toml`), the `--environment` flag and `/environment` dialog (was `--runtime` and `/runtime`), and the matching SDK session methods and REST paths (was `*Runtime*`).
