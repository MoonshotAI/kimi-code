---
"@moonshot-ai/kimi-code": patch
---

Sharpen the conversation-compaction handoff prompt so resumed sessions continue more reliably: the summary now leads with the intent of the latest request instead of re-transcribing it, carries forward tool results (not just the commands that produced them), separates settled decisions from still-open questions, names the context the next turn must re-check, matches the conversation's language, and stays proportional to the task. Also corrects the system prompt's description of the post-compaction shape.
