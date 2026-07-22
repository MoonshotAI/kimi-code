---
"@moonshot-ai/kimi-code": patch
---

web: Add an opt-in setting to render $…$ as inline LaTeX in chat messages; it stays off by default because bare $ in prices or variables like $PATH can be misdetected as math. Enable it in Settings → General → Inline math rendering.
