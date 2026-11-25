---
"@moonshot-ai/kap-server": patch
---

Report context items by where each message came from. User-role messages now come back as `user`, `reminder`, `skill`, or `compaction` items named after their source, and each thinking block, reply text, and tool call of a model message is listed as its own item with a `segment` field.
