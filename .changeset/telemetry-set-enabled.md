---
"@moonshot-ai/kimi-telemetry": minor
---

Add a module-level `setTelemetryEnabled` setter that pauses event intake and drops queued/buffered events without detaching the sink, plus an `initiallyEnabled` bootstrap option that starts intake paused and skips the startup disk-event replay while the host gate begins closed (spooled events are kept and replayed by a later consenting start), so hosts with a dynamic consent switch can toggle sending without re-initialization.
