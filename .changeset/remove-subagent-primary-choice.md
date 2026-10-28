---
"@moonshot-ai/kimi-code": patch
---

Stop offering Agent and AgentSwarm subagents an implicit `primary` choice that ran them on your current model and thinking level, and hide the model choice entirely when `[secondary_model]` names only one model; list two or more aliases in `[secondary_model.models]` to choose again, noting a listed main model uses `default_effort` and does not follow `/model` switches.
