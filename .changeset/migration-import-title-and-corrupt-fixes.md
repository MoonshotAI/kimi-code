---
"@moonshot-ai/kimi-code": patch
---

Fix two kimi-cli session import edge cases: a blank/whitespace-only custom title is no longer imported as an all-spaces, falsely-custom session title (it falls back to the prompt prefix), and an imported `context.jsonl` whose lines are all valid JSON but not objects is now classified as empty rather than reported as a corrupt migration failure.
