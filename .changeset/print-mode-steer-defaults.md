---
"@moonshot-ai/kimi-code": patch
---

In print mode (`kimi -p`), keep the run alive by default while background tasks are pending and feed each completion back to the main agent as a new turn, with an effectively unbounded wait ceiling and turn cap and a 72-hour subagent timeout. Set `print_background_mode = "exit"` (or `"drain"`) to restore the previous exit-after-one-turn behavior.
