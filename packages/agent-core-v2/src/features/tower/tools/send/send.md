Send an inbox message to a tower participant: a roster agent by name, "tower" (the control tower), or "all" (broadcast).

Recipients read it with TowerInbox. Sending to yourself or to an unknown name is rejected — the error lists the known names.

Delivery is push when the recipient is a roster agent mid-turn: the message is steered into its running turn as an injected directive, so it sees the new message at its next step boundary — the in-flight tool call finishes first, steering never aborts it — instead of at its next self-initiated inbox check. The tool result reports whether the message was steered, sits in the inbox of an idle agent, or is undeliverable (no running task — resume the agent to deliver it). If a directive genuinely cannot wait, TaskStop the recipient's task and resume it with the message instead — word the subject accordingly (e.g. "URGENT: stop and rebase") so the steer preview carries the priority. TowerComplete and TowerReview store their standard notifications automatically; do not repeat those with a manual TowerSend.

If the tower state was lost (.tower/comms deleted while .tower/ survives), the send first recovers a minimal state stamped recoveredAt instead of failing, then delivers normally; a caller whose roster entry was lost is re-registered as a placeholder named after its agent id, and the result notes it.
