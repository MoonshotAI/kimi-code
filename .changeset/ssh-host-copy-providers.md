---
"@moonshot-ai/kimi-code": patch
---

Copy the model providers you choose from this computer to an SSH host. Providers with a stored API key are copied together with their models and replace providers with the same name on the host, including that provider's models, and the host reports which of your providers it already has unchanged. Providers that use OAuth, read their key from an environment variable, or point at this computer's own address are skipped. You can also remove a synced provider and its models from the host; only providers still identical to yours are removed, and a host default model that pointed at one moves to another model.
