Rebase a mission branch onto the current base branch, inside the mission's own worktree.

The tower uses this when `TowerMerge` refuses with `stale-base` (the base moved after the branch spawned) or after a merge reports branches that now conflict with the base. The rebase runs in the mission worktree on the base branch's latest commit:

- Refuses while the mission's worker is mid-turn or the worktree has uncommitted changes — rebasing under a running worker could race its edits.
- Clean rebase → the branch tip moves; the old review keeps its exact-tip binding, but merge approval still requires a clean review with merge recommendation "merge" (never `hold` or `fix-then-merge`).
- Conflict → only a rebase left in progress with actual unmerged paths is classified as a conflict: it is aborted with recovery postconditions checked, the files are reported, and the mission is marked blocked for the worker. Other errors are not mislabeled as conflicts; failed abort or recovery is reported as recovery-required.

A rebase that drops the spawn-time WIP snapshot commit is expected — the diff then falls back to the base branch. Only the tower runs this tool; a worker rebases only when the tower asks it to.
