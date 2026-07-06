---
"@moonshot-ai/kimi-code": patch
---

AskUserQuestion now feeds answers back to the model as question text and option labels (e.g. `{"answers":{"Which database?":"Postgres"}}`) instead of synthesized ids like `q_0`/`opt_0_1`, so the model no longer has to map positional ids back to the original options — the wire protocol is unchanged, clients still answer with option ids. Question texts must now be unique per call and option labels unique per question; the web transcript card resolves both the new label form and legacy id transcripts.
