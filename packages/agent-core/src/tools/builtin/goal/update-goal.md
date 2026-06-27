Set the status of the current goal. This is how you resume, end, or yield an autonomous goal.

- `active` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.
- `complete` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded.
- `blocked` — an external condition or required user input prevents progress, or the objective cannot be completed as stated. The goal stops but can be resumed later. Do not use `blocked` merely because the work is hard, slow, uncertain, or incomplete — reserve it for a genuine impasse.
- `paused` — set the goal aside for now (e.g. to hand control back to the user). It can be resumed later.

If the goal is active and you do not call this, the goal keeps running: after your turn ends you will be prompted to continue. Call `complete` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call `complete` after only producing a plan, summary, first pass, or partial result. If you call `blocked`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.
