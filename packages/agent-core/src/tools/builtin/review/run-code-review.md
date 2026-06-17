Run a read-only code review of Git changes: fan out independent reviewer subagents over the selected changes and return a consolidated review (also saved as a browsable artifact).

Use this when the user asks you to review changes — uncommitted work, a branch, or a commit (e.g. "review my changes", "review this branch before I open a PR"). First study the actual diff yourself, then call this once.

Choosing `target` (which changes to review):
- Uncommitted / "my changes" → `{ "scope": "working_tree" }`
- A branch against a base → `{ "scope": "current_branch", "baseRef": "<base, e.g. main>" }`
- A single commit → `{ "scope": "single_commit", "commit": "<sha>" }`
Inspect git (status/log) to resolve refs, or ask the user briefly when the scope is unclear.

Choosing `intensity`:
- `standard` — one reviewer; the default for routine changes.
- `thorough` — one reviewer per direction, then reconciliation; for changes worth a careful pass before a PR.
- `deep` — directions × file groups via an agent swarm, then reconciliation; for large or risky changes. It spawns many subagents, so reserve it for when the user asks or the change clearly warrants it.

What you provide (the reviewers are fresh and independent — each only sees your background, its assigned files, and its direction):
- `background` — a briefing: what the change is, its intent, and the context needed to judge it. Factual orientation, not a verdict; do not state whether the code is correct.
- `directions` — the review angles to cover; each becomes one reviewer's focus. Lead with the user's stated concern if they gave one, then add the angles the change warrants. Provide at least two for `deep`.
- `change_type` (optional) — a short label, e.g. "TUI refactor".

After it returns, summarize the outcome for the user. The review is saved and can be reopened with `/review read`.
