---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
---

Replace hardcoded English strings in CLI command descriptions with proper i18n calls so `kimi --help` respects the configured locale. Fix locale propagation from the CLI shell to agent-core.
