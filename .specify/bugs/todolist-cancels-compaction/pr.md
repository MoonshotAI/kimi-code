# Bug Fix PR: pause context injection during compaction

- **Slug**: todolist-cancels-compaction
- **Opened**: 2026-08-25
- **PR**: 11
- **URL**: https://github.com/arrrrny/kimi-code-sync/pull/11
- **Branch**: fix/todolist-cancels-compaction
- **Issue**: n/a (bug was not filed as a GitHub issue; `auto_create_issue` is false)

Makes the context injector skip reminder injections (e.g. the TodoList stale-list reminder) while a compaction is in flight, so an active TodoList no longer cancels the in-flight compaction via `historySafeToCompact`. Mirrors the existing prompt-service guard that already pauses goal continuation turns during compaction.
