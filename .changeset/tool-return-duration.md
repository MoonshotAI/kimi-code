---
'@moonshot-ai/core': patch
---

Add an optional durationMs to the tool return and result contracts and to tool message attributes, so executors can record measured tool durations and stopping hooks can pass the measured duration when abandoning a call.
