---
"@moonshot-ai/agent-core": patch
---

Drop orphan tool results at the projection boundary so a malformed history cannot brick a session. A `tool` result whose assistant `tool_call` is nowhere in the history (e.g. an older session whose compaction cut fell inside a tool exchange, restored via the legacy path) is now removed from every projected request, not only on the post-400 strict resend. The stored history is left faithful to the wire records — so consumers that model it, like the transcript fold length, stay in sync — while a strict provider (OpenAI / DeepSeek) always receives a valid request. The drop is surfaced via the projection-repair log rather than done silently.
