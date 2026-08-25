Move the active flow run to another stage: backward to redo work whose conclusion was invalidated, or forward to skip stages that do not apply to this task.

Use this instead of FlowAbort when the run itself is still sound and only its position is wrong. The jump is recorded in the run's audit trail with your reason; a skipped stage keeps no acceptance record, so the reason must say why skipping is safe.

Whether a jump needs the user's approval is set by the flow definition (`jumps: approval` — the default — asks the user; `jumps: free` does not; `jumps: disabled` forbids jumping). Submit FlowJump as the only call in its response.
