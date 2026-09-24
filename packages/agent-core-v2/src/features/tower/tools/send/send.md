Send an inbox message to a tower participant: a roster agent by name, "tower" (the control tower), or "all" (broadcast).

Recipients read it with TowerInbox. Sending to yourself or to an unknown name is rejected — the error lists the known names.

Delivery is push when the recipient is a roster agent mid-turn: the message is steered into its running turn as an injected directive, so it sees the new message at its next step boundary (after the current tool call finishes) instead of at its next self-initiated inbox check. The tool result reports whether the message was steered, sits in the inbox of an idle agent, or is undeliverable (no running task — resume the agent to deliver it).

`urgent: true` marks the message as an interruption directive. Delivery works the same way — urgent does NOT abort the recipient's in-flight tool call; for a hard abort, TaskStop the recipient's task and resume it with this message instead.
