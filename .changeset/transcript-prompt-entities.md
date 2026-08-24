---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/node-sdk": patch
---

Expose prompt queue entities through the transcript surface: accepted and queued prompts carry their content, queued prompts keep it after dequeueing, and the schema-less prompt.accepted event no longer leaks into the v1 event stream.
