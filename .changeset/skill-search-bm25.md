---
"@moonshot-ai/kimi-code": minor
---

Add BM25-based skill search for large catalogues. When >80 skills are installed, the system prompt switches from a full listing to a compact name-only format and the model discovers skills via the Skill tool's new `action: "search"` endpoint. Startup memory reduced ~95% via lazy content loading.
