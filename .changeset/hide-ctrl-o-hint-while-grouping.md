---
"@moonshot-ai/kimi-code": patch
---

Stop showing the ctrl+o expand and collapse hint in the fullscreen footer while tool or thinking grouping is on; ctrl+o still works, and setting `tool_call_density = "ungrouped"` and `thinking = "ungrouped"` under `[transcript]` in tui.toml brings the hint back.
