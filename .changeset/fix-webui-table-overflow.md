---
"@moonshot-ai/kimi-web": patch
---

Fix markdown table overflow with long unbroken text in Web UI

Add `overflow-wrap: anywhere` to table cells so long continuous text
(URLs, base64, tokens) wraps inside the cell instead of stretching the
table past the chat container width.
