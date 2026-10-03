---
"@moonshot-ai/kimi-code": minor
---

Add experimental OS-level sandboxing, parsed exec-policy rules, and network egress control for agent shell commands on macOS and Linux. Enable with `KIMI_CODE_EXPERIMENTAL_SANDBOX=1` and the `[sandbox]` config section; `KIMI_CODE_EXPERIMENTAL_EXEC_POLICY=1` enables layered `.rules` files under `rules.d/`; `KIMI_CODE_EXPERIMENTAL_NETWORK_EGRESS=1` enables the `[sandbox.network]` allowlist proxy.
