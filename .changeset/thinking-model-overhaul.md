---
"@moonshot-ai/kimi-code": major
"@moonshot-ai/kimi-code-sdk": major
---

Consolidate thinking configuration into `[thinking] enabled` / `effort`, removing the top-level `default_thinking` field and `thinking.mode`. Migrate: `default_thinking = true` → `[thinking] enabled = true`; `default_thinking = false` or `mode = "off"` → `enabled = false`; `mode = "on"` / `mode = "auto"` → delete the line. Effort levels now come from each model's declared `support_efforts` instead of a fixed enum.
