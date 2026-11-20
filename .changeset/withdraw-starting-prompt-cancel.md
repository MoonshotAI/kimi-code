---
"@moonshot-ai/core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Cancelling a prompt by id while its turn is still starting (for example while prompt-submit hooks run) now withdraws the prompt: it is no longer appended to the context or sent to the model, the turn is dropped without being recorded (or ends as aborted if it was already announced), and the next queued prompt starts in its place. Previously the cancel was reported as successful while the prompt still ran.
