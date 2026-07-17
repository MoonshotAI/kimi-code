---
"@moonshot-ai/kimi-code": patch
---

web: Fix LaTeX formulas rendering as garbled overlapping text when the web UI is accessed over the network; the server's content security policy now allows the inline styles that math and code highlighting rely on, while scripts remain strictly restricted.
