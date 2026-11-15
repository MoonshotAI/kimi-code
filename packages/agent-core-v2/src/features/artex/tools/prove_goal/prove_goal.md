Call when you judge that a finding/fact proves a goal met: links the evidence node to the goal node and marks the goal met.

A fact counts as evidence only when its `confidence` is `observed` and its `source` is not `target_response` (the target could have planted it); any other fact is refused and the goal stays open. A finding always counts.

- `goal_id`: the goal node id.
- `evidence_id`: the id of the finding/fact node that proves it.
- `reason`: why this evidence satisfies the goal.

When the last open goal of the task is marked met, the task is automatically judged complete.
