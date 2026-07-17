---
"@moonshot-ai/kimi-code": patch
---

Fix the web backend's file-reading tools mishandling symbolic links: Read rejected them as not regular files, and media size checks measured the link instead of its target.
