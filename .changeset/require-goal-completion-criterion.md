---
"@moonshot-ai/kimi-code": minor
---

Enforce concrete completion criteria when creating goals. The model must now provide a verifiable check (at least 10 characters) before starting a goal; vague requests like "review the project" are rejected with a prompt to ask the user for specifics.