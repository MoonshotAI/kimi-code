---
"@moonshot-ai/kimi-code-oauth": minor
---

Rework the host identity type: rename `userAgentProduct` to `productName` and add a required `platform` field, so every host explicitly declares the `X-Msh-Platform` value it reports instead of silently inheriting the CLI's.
