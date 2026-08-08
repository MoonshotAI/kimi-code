---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Report a malformed record in `plugins/installed.json` as a load error naming the offending entry, instead of handing the record to the plugin manager and crashing later on a missing field.
