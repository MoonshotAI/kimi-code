Read or update a tower mission.

With only an id, returns the mission view (status, tasks, blockers, notes). With patch fields, applies them: workers may only update the mission they own — the store rejects anything else. Use task_done to tick checklist items, note to log decisions, blocker when stuck (the tower watches for blocked missions).
