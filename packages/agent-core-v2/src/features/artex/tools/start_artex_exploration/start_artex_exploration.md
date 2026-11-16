Start, pause, resume, or inspect an ARTEX autonomous exploration graph and its continuous 120-subagent orchestrator.

Actions:
- `start` (default): Initializes a new exploration graph with `goal` (and optional `description`, `exploration_id`, `target_concurrency`, `timeout_seconds`, `token_budget`, `turn_budget`), activates ARTEX mode, and runs the continuous orchestrator (in the background by default, or awaited if `background=false`).
- `pause`: Pauses the running orchestrator for the active or specified `exploration_id`.
- `resume`: Resumes an initialized exploration on the continuous orchestrator.
- `status`: Returns the live orchestrator status and node statistics.
