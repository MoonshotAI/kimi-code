---
"@moonshot-ai/agent-core-v2": patch
---

Check that the system prompt was rendered for the session's working directory by comparing the two as the same directory instead of as identical strings, so a Windows session whose working directory is spelled with forward slashes or a different drive-letter case gets the date reminder and the reminder when the date changes.
