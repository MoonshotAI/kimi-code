---
"@moonshot-ai/kimi-code": minor
---

Add tower mode as a plan-parallel mode gated behind an experimental flag (off by default). Set `KIMI_CODE_EXPERIMENTAL_TOWER=1` to enable it; `/tower` reports status, `/tower on|off` toggles the mode with a footer indicator, and `/tower <objective>` starts multi-agent orchestration.
