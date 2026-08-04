---
"@moonshot-ai/kimi-code": patch
---

Queue slash skill commands entered while the agent is busy instead of rejecting them with "Cannot /<cmd> while streaming". Skills that declare `allow-activation-while-busy` in frontmatter (such as /tower) still take effect immediately at the next step boundary.
