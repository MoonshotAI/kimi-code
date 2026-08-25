---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add multi-stage flow runs (on by default; disable with `KIMI_CODE_EXPERIMENTAL_FLOW=false`): define staged workflows with gated transitions under the project's `.kimi-code/flows/` or the user-level `~/.kimi-code/flows/` and run them with `/flow:<id>`, or let `/flow <task>` draft a new flow with you; starting a drafted or manually requested run asks for your approval on the blueprint first.
