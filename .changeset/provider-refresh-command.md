---
"@moonshot-ai/kimi-code": minor
---

Add a `/provider refresh [providerId]` subcommand that re-fetches model lists from providers at runtime. Run `/provider refresh` to update every provider, or `/provider refresh <providerId>` to update one. Typing an unknown `/provider` subcommand now shows a usage hint instead of silently opening the provider manager.
