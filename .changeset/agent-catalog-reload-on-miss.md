---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Pick up agent files written after a session started: when a subagent dispatch names a profile the session catalog does not have, the agent directories are rescanned once and the lookup retried before the dispatch fails. Fixes long-lived `kimi web` sessions never seeing newly added agent Markdown files.
