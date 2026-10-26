Submit a review verdict for a branch you were assigned to review (via TowerSpawn review_target). For an artifact mission, the tower also uses this tool to record explicit human acceptance; no independent reviewer is required.

The review is stamped with the current branch tip — if the branch moves afterwards, the tower must ask for a re-review before merging. Normal merge-bound reviews come from an assigned independent reviewer. A tower-submitted build review is exceptional break-glass and must explicitly record reviewer=tower and the reason; it is not a convenience bypass. Only those reviewers (or the tower in that exceptional case) may submit; the round number is assigned automatically.

For artifact acceptance, show the user every committed artifact path and wait for explicit approval in the current conversation; never infer it from NotifyUser, automatic tool approval, a timeout, or an auto/noninteractive run. Then record reviewer=tower with status=clean and merge=merge. Any later commit or rebase requires fresh acceptance. Record requested changes as non-clean feedback for rework.

The tool stores the standard review-result notifications in the same protocol flow: clean verdicts notify the tower; non-clean verdicts also notify a valid owner of an open mission, with a supervisory copy to the tower. Closed missions never wake their former author. Do not send a second manual TowerSend.

The result lists the review file and actual recipients, then reports gate semantics: for build missions, only a clean review with merge=merge on the exact tip is merge-ready; hold and fix-then-merge are not approval.
