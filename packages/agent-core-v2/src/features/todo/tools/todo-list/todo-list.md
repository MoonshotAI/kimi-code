Maintain a TODO list for multi-step work. The user sees it as a live progress panel, so keep it truthful: mark an item `done` only when it is actually finished — not while its tests fail, its implementation is partial, or something it needs is missing. For work that takes only a step or two, a list adds nothing. In plan mode, the plan belongs in the plan file instead.

- Call with `todos: [...]` to replace the full list (statuses: pending / in_progress / done), with no `todos` to read the current list, or with `todos: []` to clear it.
- Keep titles short.
- An update can go in the same response as your other tool calls; re-sending an unchanged list adds nothing.
