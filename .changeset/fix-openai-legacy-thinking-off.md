---
"@moonshot-ai/kimi-code": patch
---

Honor an explicit thinking "off" on OpenAI-compatible (chat completions) providers: it used to be indistinguishable from "never configured", so the history-based auto `reasoning_effort` injection kept the model reasoning (and could leak the field to models that reject it). The provider now also reports the actual current thinking effort ("on"/"off") instead of recording "off" for both.
