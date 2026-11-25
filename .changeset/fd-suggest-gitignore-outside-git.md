---
"@moonshot-ai/agent-core-v2": patch
---

Pass `--no-require-git` to fd file suggestions so `.gitignore` files apply outside a git repository, as they already do for the ripgrep and filesystem strategies. When fd rejects its arguments, as releases before 8.7 do, fall back to ripgrep or the filesystem walk and stop using that fd for the session instead of returning no suggestions.
