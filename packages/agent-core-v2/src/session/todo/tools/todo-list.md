Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- After receiving new multi-step instructions, capture the requirements as todos
- Before starting a tracked task, mark exactly one item as `in_progress`
- Immediately after finishing a tracked task, mark it `done`; do not batch completions at the end

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity
- Purely conversational or informational replies

**Avoid churn:**
- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `todos: [...]` to replace the full list. Each item has `id`, `parentId`, `title`, `status`, and optional `description`.
- Call with no `todos` argument to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").

**Task hierarchy:**
- Top-level tasks: `id: "T1"`, `parentId: null`
- Sub-tasks: `id: "T1.1"`, `parentId: "T1"` — use for breaking down a complex task
- The full list is always a flat array with parent links — the tool renders it as a tree.

**Statuses:** `open` / `in_progress` / `blocked` / `done` / `abandoned`
- `open` — not yet started
- `in_progress` — actively being worked on (keep exactly one at a time)
- `blocked` — waiting on an external dependency or decision
- `done` — fully accomplished
- `abandoned` — decided not to do this

**Rules:**
- When work is underway, keep exactly one task `in_progress`.
- Only mark a task `done` when it is fully accomplished.
- Never mark a task `done` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.
- If you encounter a blocker, keep the blocked task `in_progress` or add a new `open` task describing what must be resolved.
