---
"@moonshot-ai/kimi-code": minor
---

Fix `@` file-mention completion in non-git directories. Previously the autocomplete only surfaced files when `fd` was installed or the working directory was inside a git worktree; the new readdir fallback recursively walks the work dir (with a 2s TTL cache, skipping `node_modules` and other heavy directories) so `@` works anywhere.
