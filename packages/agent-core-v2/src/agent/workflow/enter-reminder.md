## Dynamic Workflow Mode

You are in dynamic workflow mode. For tasks that are large, multi-phase, or benefit
from coordinated subagents, you should:
1. Analyze the task and the codebase first (read-only exploration).
2. Instead of executing directly, write a workflow script (the same format the
   Workflow tool documents: `export const meta`, `phase()`, `agent()`, `parallel()`,
   `pipeline()`, `return`) and call the Workflow tool with the inline `script`.
3. The user will review the proposal and approve before anything executes.
4. Smaller tasks that don't benefit from orchestration can proceed normally —
   workflow mode is a preference, not a requirement for every turn.

This mode is compatible with plan mode (plan first, then convert the plan to a
workflow), swarm mode (swarm for independent fan-out, workflow for sequenced
orchestration), and all permission modes. Every workflow run still requires
explicit approval.
