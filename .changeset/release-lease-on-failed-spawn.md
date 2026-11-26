---
"@moonshot-ai/agent-core-v2": patch
---

Release the environment lease when a git, gh or ripgrep command fails to start, so removing that environment no longer waits out the lease drain timeout.
