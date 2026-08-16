---
"@moonshot-ai/kimi-code": patch
---

Evaluate Bash permission rules per sub-command: an allow rule now auto-approves a compound command (`&&`, `;`, `|`, command substitution, …) only when every sub-command matches it, and deny/ask rules match when any sub-command does. Commands that cannot be parsed keep whole-string matching.
