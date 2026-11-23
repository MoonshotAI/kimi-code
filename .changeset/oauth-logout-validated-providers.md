---
"@moonshot-ai/agent-core-v2": patch
---

Clean up managed OAuth configuration using validated provider state during logout, so invalid raw configuration of unrelated providers no longer causes a validation error.
