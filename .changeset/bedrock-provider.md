---
"@moonshot-ai/kimi-code": minor
---

Add an Amazon Bedrock provider that authenticates through your AWS credentials instead of a long-lived API key, and can serve Claude, GPT, and Kimi models. Set `type = "bedrock"` on a provider and put `AWS_REGION` (and optionally `AWS_PROFILE`) in its `[providers.<name>.env]` sub-table.
