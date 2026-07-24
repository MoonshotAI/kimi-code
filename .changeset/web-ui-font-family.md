---
"@moonshot-ai/kimi-code": patch
---

web: Add font family preferences to Appearance settings (desktop dialog + mobile sheet). The UI/reading font offers Default (Inter), System, Serif, and Custom faces; the code font offers Default (JetBrains Mono), System, and Custom. Custom shows a dropdown of locally installed fonts (detected by probing a curated candidate list, e.g. Maple Mono NF CN) with a manual entry fallback; the default stack is appended as fallback so nothing extra is downloaded. Choices remap the `--font-ui` / `--font-mono` tokens via `<html data-ui-font-family>` / `<html data-code-font-family>`, so every surface picks them up with no component changes; the xterm terminal keeps its fixed literal stack.
