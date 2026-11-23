---
"@moonshot-ai/kap-server": patch
---

Replace `POST /sessions/{id}/prompts` with `PUT /sessions/{id}/prompts/{prompt_id}`: the path id is the idempotency key, the body accepts `delivery: "steer"`, and the response reports `accepted_as` plus the started `turn_id`. The old POST route is removed. HOST_API_LEVEL is now 2.
