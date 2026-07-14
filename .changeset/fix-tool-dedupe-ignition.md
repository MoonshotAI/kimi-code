---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix the v2 engine never activating tool-call deduplication: identical tool calls issued in the same step no longer execute multiple times, and repeated identical calls across steps receive escalating reminders again.
