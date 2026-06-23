---
"@moonshot-ai/kimi-code": patch
---

Render LaTeX math in the web chat: inline `$…$` and block `$$…$$` now display as formatted formulas via KaTeX. Plain prose dollars (e.g. `$PATH`, `$5 and $10`) are kept as literal text instead of being swallowed as a formula.
