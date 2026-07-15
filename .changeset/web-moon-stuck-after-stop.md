---
"@moonshot-ai/kimi-code": patch
---

web: Fix the activity indicator (moon) occasionally staying visible after a session's turn has already stopped. The web derives the working state directly from the main agent's turn boundary events, and the server computes the session's busy state from each agent's activity (active turn or background task) instead of a separately-registered status, so a finished or aborted turn always clears the indicator. The Stop button now appears under exactly the same condition as the moon, and background tasks no longer keep the chat-area indicators spinning after the main turn ends. Also fixes durable session events (including the busy transitions) sometimes not being flushed to the on-disk journal until the next event arrived, and fixes streamed text and tool cards showing twice after an LLM retry: the retried step now refills the same bubble in place instead of leaving the failed attempt's partial bubble next to it.
