Merge a tower mission branch into the base branch (--no-ff). A zero-diff survey is the only no-op close; build and artifact missions perform a real merge.

Hard gate, enforced by the store:
- The mission is completed with no open tasks or blockers and every related worker observably idle.
- Build missions: the latest applicable review is "clean" with merge recommendation "merge" on the exact branch tip (`hold` and `fix-then-merge` are never approval; only a conflict-free TowerRebase waives the tip binding). Legacy clean reviews with no merge field retain their original compatibility.
- Artifact missions: artifact acceptance of the entire committed tip, recorded as a mission-matching reviewer=tower clean+merge review on that exact tip, which must equal the completion tip of the latest TowerComplete acceptance-request. Approval covers every in-scope change at the tip (key artifacts are highlights, not a whitelist); an unaccepted commit or a rebase requires a fresh TowerComplete and acceptance.
- All dependency missions are merged or abandoned; the branch contains the current base tip (otherwise `stale-base` — run TowerRebase first); every changed file is inside the mission's declared scope.
- Not every mission record for the branch is closed (abandoned or already merged) — a merge never flips a historical mission's state; if the work must land, re-plan it under a fresh mission title.

The scope diff starts from the spawn-time WIP snapshot commit while it remains in the branch's history, falling back to the base branch once a rebase drops it. On refusal, the error message tells you what to do next. After a merge, branches reported as conflicting must rebase onto the new base (TowerRebase, or the worker itself when mid-turn) before they can merge. If the git merge itself conflicts, it is aborted automatically — the checkout is never left mid-merge.

The main checkout must be clean for the files the merge touches: uncommitted changes in any file the merge would overwrite refuse the merge, and nothing is merged — commit or stash those changes first, then retry. This matters especially when a mission branch carries a spawn-time WIP snapshot: those changes merge into the base history, so they must not also sit uncommitted in the checkout.

When this merge closes the last open mission, the result reports the workspace ready for TowerTeardown.
