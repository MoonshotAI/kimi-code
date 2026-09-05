# Bug Issue: Goal should pause and auto-resume around auto compaction instead of repeatedly cancelling it

- **Slug**: goal-pause-compaction
- **Reported**: 2026-08-24
- **Fork issue (primary)**: 9 — https://github.com/arrrrny/kimi-code-sync/issues/9
- **Upstream duplicate**: 3204 — https://github.com/MoonshotAI/kimi-code/issues/3204 (REMOVE: was a misfiling before the fork had Issues enabled; close it)
- **Severity**: medium

Goal running auto compaction gets cancelled repeatedly because the goal runtime is unaware of compaction; proposed fix is to make the goal pause on auto-compaction begin (with TUI feedback) and auto-resume on compaction complete. The user wants the issue tracked on their fork `arrrrny/kimi-code-sync`, which now has Issues enabled. The `severity:medium` label does not exist there; only `bug` was applied.

Fork issue attempt history: `gh issue create --repo arrrrny/kimi-code-sync` first failed with "the 'arrrrny/kimi-code-sync' repository has disabled issues"; after the user enabled Issues on the fork, it succeeded as issue #9.
