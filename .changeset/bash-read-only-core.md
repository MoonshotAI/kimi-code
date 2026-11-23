---
"@moonshot-ai/agent-core-v2": patch
---

Approve statically read-only Bash commands (file inspection, search such as `rg`/`find`/`fd`/`grep -r`, text filtering such as `sort`/`jq`/`sed -n`, and read-only `git` subcommands) with flag allowlists, Windows UNC and Git Bash path checks, bare-repo checks, and sensitive/`.git` target guards.
