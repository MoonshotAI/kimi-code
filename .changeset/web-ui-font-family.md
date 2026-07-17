---
"@moonshot-ai/kimi-code": patch
---

web: Add a font family preference to Appearance settings (desktop dialog + mobile sheet) with Default (Inter), System, and Serif faces. The choice remaps the `--font-ui` token via `<html data-ui-font-family>`, so UI and reading text switch fonts while code stays monospace; both alternate stacks use locally installed fonts, so nothing extra is downloaded.
