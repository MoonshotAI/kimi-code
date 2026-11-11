---
"@moonshot-ai/kimi-code": patch
---

Copy model providers from this computer to an SSH host. Providers with a stored API key are copied together with their models, and providers the host already has are left unchanged. Providers that use OAuth, read their key from an environment variable, or point at this computer's own address are skipped.
