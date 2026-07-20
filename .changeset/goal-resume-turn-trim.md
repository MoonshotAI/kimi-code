---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
---

Fix resume replaying an entire goal session from the start: goal continuation rounds now count as turns when trimming resumed history (the most recent 10 are kept), and the goal driver's synthetic continuation prompts no longer render as user messages on replay.
