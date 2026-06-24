---
"@moonshot-ai/kimi-code": patch
---

Render LaTeX display math (`$$…$$`) in the web chat via KaTeX. Single `$` is intentionally left as literal text, so prices, env vars, and shell paths (e.g. `$PATH`, `$5/$10`, `$HOME/bin`) are never swallowed as a formula.
