Rebase a mission branch onto the current base branch, inside the mission's own worktree.

The tower uses this when `TowerMerge` refuses with `stale-base` (the base moved after the branch spawned) or after a merge reports branches that now conflict with the base. The rebase runs in the mission worktree on the base branch's latest commit:

- Refuses while the mission's worker is mid-turn or the worktree has uncommitted changes — rebasing under a running worker could race its edits.
- Clean rebase → the branch tip moves; a previously clean review on the old tip stays valid (the merge gate waives the re-review for a conflict-free tower rebase).
- Conflict → the rebase is aborted, the conflicted files are reported, and the mission is marked blocked so the worker resolves them.

A rebase that drops the spawn-time WIP snapshot commit is expected — the diff then falls back to the base branch. Only the tower runs this tool; a worker rebases only when the tower asks it to.
