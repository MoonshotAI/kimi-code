---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/protocol": patch
---

Add a `Monitor` tool: run a self-filtering shell command in the background and receive each new stdout line as a notification (with batching and an auto-stop volume cap). Stop with `TaskStop` or let it time out; `persistent` watches run until the session ends.
