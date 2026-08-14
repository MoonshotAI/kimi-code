Split the tower goal into missions. Each mission gets an id (M1, M2, …), a branch (feat/<slug>), and an isolated git worktree (.tower/worktrees/wt-N).

Rules enforced by the store: scopes of build missions must be pairwise disjoint (survey missions are read-only and reserve no scope), and deps must reference existing mission ids. Plan once, then spawn one worker per mission with TowerSpawn. Requires an active tower workspace (run TowerInit first).
