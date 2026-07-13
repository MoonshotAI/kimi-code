---
"@moonshot-ai/agent-core-v2": patch
---

Align v2 media reads with v1: the ReadMediaFile summary moves to the tool result's note side channel so raw `<system>` markup never renders in UIs, image dimensions are reported in the decoded EXIF-rotated space so portrait photos get correct coordinate guidance, the downscale cap rises from 2000px to 3000px with a gentler byte-budget fallback, and image compression and crop telemetry is reported for media reads.
