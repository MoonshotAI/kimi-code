Split the tower goal into missions. Each mission gets an id (M1, M2, …), a branch (feat/<slug>), and an isolated git worktree (.tower/worktrees/wt-N).

Write tasks as verifiable check items — the worker ticks them off, the completion report reconciles against them item by item, and the reviewer maps every one to the diff. When the user's own words carry intent your paraphrase could lose, copy the key sentences into `context` verbatim (when in doubt, include it): context supplements your paraphrase, never replaces it, travels with the mission into the worker and reviewer briefings, and is never the full conversation history.

Rules enforced by the store: scopes of build missions must be pairwise disjoint (survey missions are read-only and reserve no scope), and deps must reference existing mission ids. Plan once, then spawn one worker per mission with TowerSpawn. Requires an active tower workspace (run TowerInit first).
