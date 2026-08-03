---
"@moonshot-ai/kimi-code": minor
---

Add the TurnStarted, UserPromptQueued, TaskStarted, and SessionHeartbeat hook events, enrich hook payloads with the session title and client type, include the model and profile in SessionStart, and report SessionEnd as archive when a session is archived instead of exited. Configure the new events under [[hooks]] in config.toml.
