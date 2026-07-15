---
"@moonshot-ai/kimi-code": patch
---

web: Fix the activity indicator (moon) occasionally staying visible after a session's turn has already stopped. The web derives the working state directly from the main agent's turn boundary events, and the server computes the session's busy state from each agent's activity (active turn or background task) instead of a separately-registered status, so a finished or aborted turn always clears the indicator. Also fixes durable session events (including the busy transitions) sometimes not being flushed to the on-disk journal until the next event arrived.
