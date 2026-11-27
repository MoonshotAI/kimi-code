---
"@moonshot-ai/kap-server": patch
---

Creating a provider now fails instead of overwriting when a generated model alias key already belongs to another provider, and editing a provider fails when two of its models would end up with the same alias key.
