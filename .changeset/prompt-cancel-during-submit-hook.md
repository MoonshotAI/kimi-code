---
"@moonshot-ai/agent-core-v2": patch
---

Fix a prompt cancelled while its submit hook was still running starting its turn anyway and running the hook a second time.
