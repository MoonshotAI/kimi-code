View an intent (work)'s execution process (not just its final output). Three usages:
1. `intent_id` only: returns a summary stream of the work's steps (`summary <= 100 chars`, with `step_id`; action outline only, no full output).
2. `intent_id` + `q`: returns only the summaries of steps matching the keyword (searches both summaries and full output).
3. `intent_id` + `step_ids`: returns the full content (`detail`/`text`) of those steps; at most 5 per call (extras beyond 5 are reported in `omitted_step_ids`).

Thinking and usage steps are excluded.
