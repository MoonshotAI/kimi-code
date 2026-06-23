---
"@moonshot-ai/kimi-code": patch
---

Render LaTeX math in the web chat: inline `$…$` and block `$$…$$` now display as formatted formulas via KaTeX. Plain prose dollars and compact price ranges (e.g. `$PATH`, `$5 and $10`, `$5/$10`) are kept as literal text instead of being swallowed as a formula.
