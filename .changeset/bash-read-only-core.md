---
"@moonshot-ai/agent-core-v2": patch
---

Approve Bash calls without asking when the bash parser proves every command segment read-only: allowlisted commands with literal arguments, input redirections, and output only to `/dev/null`, with no substitutions, assignments, or background jobs. The check runs just before the fallback ask, so user ask and deny rules, sensitive-file checks, `.git` paths, and the dangerous-command guard still take precedence, and commands that fail to parse keep asking.
