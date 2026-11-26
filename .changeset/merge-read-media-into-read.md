---
"@moonshot-ai/agent-core-v2": minor
---

Merge `ReadMediaFile` into `Read` for image and video files, remove the `region` and `full_resolution` image cropping parameters and image-crop telemetry, emit capability reminders when model media support changes, and refresh legacy `Read` schemas, filter retired `ReadMediaFile` declarations, and inject a one-time migration reminder when resuming older sessions.
