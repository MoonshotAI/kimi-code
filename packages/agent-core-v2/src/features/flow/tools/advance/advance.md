Submit your acceptance verdict for the current stage of the active flow run.

Call this after you have checked the stage's work against every clause of its `completion` definition, using objective evidence (produced artifacts, diffs, test output) — never the worker's summary alone.

- `verdict: "pass"` closes the stage. If the stage's gate is `human` or `ai-then-human`, the user reviews your criteria verdicts and evidence before the stage actually closes; a rejection comes back to you as feedback to act on. On the last stage, a pass finishes the run.
- `verdict: "reject"` records that acceptance failed and why. The flow stays at the current stage; rework it (typically by resuming the same worker with the unmet criteria) and submit again.

Every call must list a verdict for each completion criterion with the evidence you checked. This tool is only available while a flow run is active, and only accepts the current stage's id.
