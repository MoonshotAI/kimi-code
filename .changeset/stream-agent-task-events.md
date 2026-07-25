---
"@moonshot-ai/kimi-code": patch
---

Stream live subagent events into the background task output buffer. While a subagent launched through the `Agent` tool is still running, `TaskOutput` and the `/tasks` panel now show its turns, tool calls, and thinking/assistant text as they happen, instead of only the final summary after completion.
