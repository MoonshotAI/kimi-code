---
'@moonshot-ai/kimi-code': patch
---

Fix the web UI not rendering inline KaTeX math. Single-dollar inline formulas (`$…$`) now render through KaTeX, while prices, env vars, and shell paths (`$5`, `$PATH`, `$HOME/bin`) stay literal via conservative pandoc-style delimiter rules.
