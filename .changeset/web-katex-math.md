---
"@moonshot-ai/kimi-code": patch
---

Render LaTeX math in the web chat: inline `$…$` and block `$$…$$` now display as formatted formulas via KaTeX. Plain prose dollars, compact price ranges, and shell/path values (e.g. `$PATH`, `$5/$10`, `$HOME/bin:$PATH`) are kept as literal text instead of being swallowed as a formula.
