# Bug Issue: Auto-compaction should freeze everything — past fixes cancelled compaction instead

- **Slug**: auto-compaction-freeze-all
- **Reported**: 2025-08-26T08:00:02.053Z
- **Issue**: 17
- **URL**: https://github.com/arrrrny/kimi-code-sync/issues/17
- **Severity**: critical

Filed GitHub issue for the auto-compaction freeze problem, referencing past failed attempts (goal-pause-compaction #14, todolist-cancels-compaction #15). The fix should be minimal — ideally a single config setting or 1-2 if statements — not a multi-subsystem coordination.