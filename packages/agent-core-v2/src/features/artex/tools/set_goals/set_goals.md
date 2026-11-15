Add one or more final goals to this task at runtime. The planner re-judges completion against the full goal set, so adding a goal re-opens the task until every goal is proven met.

- `goals`: an array of goal statements (each a concrete, verifiable objective). For a single goal, pass the top-level `goal` instead.

Returns an `ids` array matching the submitted goals in order.
