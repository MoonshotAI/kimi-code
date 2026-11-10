---
"@moonshot-ai/kimi-code": patch
---

Submit prompts with `PUT /sessions/{id}/prompts/{prompt_id}`, which takes `delivery: "steer"` and reports `accepted_as` and the started `turn_id`; `POST /sessions/{id}/prompts` is removed and no longer available.
