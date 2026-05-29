---
"@moonshot-ai/kimi-code": patch
---

Fix the footer/statusline leaking onto the terminal above the error when resuming a non-existent session. The footer is now mounted only after startup reaches the main TUI, so a fatal startup failure no longer paints stray chrome.
