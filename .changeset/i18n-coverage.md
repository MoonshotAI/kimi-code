---
"@moonshot-ai/kimi-code": patch
---

Replace hardcoded English strings across CLI subcommands, TUI components, and update prompts with i18n `t()` calls so they respect the configured locale. Also fix ZH locale key parity (1375/1375) and a `slashCommands` path mismatch that caused raw key fallback.

web: Replace hardcoded strings in ServerAuthDialog, GoalStrip, CommandBar, Sheet, and Dialog with i18n calls.
