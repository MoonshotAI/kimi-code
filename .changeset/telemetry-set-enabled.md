---
"@moonshot-ai/kimi-telemetry": minor
---

Add a module-level `setTelemetryEnabled` setter that pauses event intake and drops buffered events without detaching the sink, plus an `initiallyEnabled` bootstrap option that starts intake paused and skips the disk-event replay until the host opens its gate, so hosts with a dynamic consent switch can toggle sending without re-initialization.
