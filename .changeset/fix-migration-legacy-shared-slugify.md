---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

fix(migration-legacy): use shared slugifyWorkDirName from agent-core

Exports `slugifyWorkDirName` from `@moonshot-ai/agent-core` and removes the
duplicate local implementation in `packages/migration-legacy/src/sessions/workdir-bucket.ts`.

No user-visible behavior change. The migrator now imports the canonical
slugifier, so migrated bucket names stay byte-identical to agent-core
without manual sync.
