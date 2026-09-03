Read or update a tower mission.

With only an id, returns the mission view (status, tasks, blockers, notes). With patch fields, applies them: workers may only update the mission they own — the store rejects anything else. Use task_done to tick checklist items, note to log decisions, blocker when stuck (the tower watches for blocked missions).

Tower only: status=abandoned gives a mission up without merging — its scope stops reserving files for TowerPlan, its dependents may merge, and its branch drops out of conflict checks. Use it for stale missions carried over from a previous session, or for work that will not land; abandoned missions stay in MISSIONS.md (🚫) as the audit trail.
