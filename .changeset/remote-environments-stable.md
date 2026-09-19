---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Remote environments are now stable: declare SSH hosts, Docker containers, or custom launcher commands in the `[environments]` config section (or a trusted project's `.kimi-code/environments.toml`) and bind a session with `kimi --environment <id>` or the `/environment` dialog so the agent's tools execute in the target environment — matching SDK session methods and REST endpoints included, no experimental flag required.
