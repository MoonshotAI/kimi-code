---
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add custom output styles. Markdown style files — built-in `concise` and `explanatory`, plus your own under `<project>/.kimi-code/output-styles/` and `~/.kimi-code/output-styles/` — are injected additively into the system prompt to shape the assistant's tone, format, and verbosity. Select one with the `output_style` config key (precedence: project > user > built-in).
