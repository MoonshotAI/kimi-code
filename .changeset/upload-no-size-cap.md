---
"@moonshot-ai/kimi-code": minor
---

Remove the 50 MB size limit on file uploads to the built-in server, so large attachments (for example in the web UI) no longer fail with an upload-too-large error. Uploads now stream to disk instead of being buffered in memory.
