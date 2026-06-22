---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Added the ability to add extra workspace directories:

- Use the `/add-dir <path>` command to add extra working directories to the current session, or remember them for the project.
- Use `kimi --add-dir <path>` to add them on startup.
- Project-level local config is now managed in `.kimi-code/local.toml`; we recommend adding it to your `.gitignore`.
