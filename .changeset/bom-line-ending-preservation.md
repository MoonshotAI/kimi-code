---
"@moonshot-ai/kimi-code": patch
---

Preserve a file's byte order mark (BOM) and line ending style when Edit or Write modifies an existing file. Overwriting with Write now normalizes supplied line endings to the file's dominant style and keeps the file's existing BOM rather than a different one supplied in the content; files with no detectable style and non-regular files (e.g. pipes) are still written literally.
