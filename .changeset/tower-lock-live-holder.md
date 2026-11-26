---
"@moonshot-ai/agent-core-v2": patch
---

Check whether a Tower state or inbox lock holder is still alive before taking the git-backed stale-lock reaper guard, so callers waiting on a live holder no longer spawn git processes on every stale check.
