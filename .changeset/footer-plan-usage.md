---
"@moonshot-ai/kimi-code": minor
---

Add opt-in footer enrichments via a new `[footer]` section in `tui.toml`. `show_version = true` renders the CLI version next to the model name, and `show_plan_usage = true` shows managed-plan quota (weekly summary plus rolling windows, with reset hints and severity-colored progress bars) to the left of the context readout, refreshed every `plan_usage_refresh_seconds` (default 60). Quota polling is silent when signed out or on non-managed providers, retries quickly until the first successful fetch, and keeps the last good data on errors; the transient exit hint takes precedence over the segment.
