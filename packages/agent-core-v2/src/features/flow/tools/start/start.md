Start a flow run from a definition file under `.kimi-code/flows/`.

Reads and validates the definition, snapshots its stages into the run state, and positions the run at the first stage. The tool output is the run blueprint: every stage with its objective, completion criteria, and gate ownership.

Before calling: restate your understanding of the task to the user, and if any stage's `completion` is too vague to verify, clarify it with the user first. Only one flow run can be active per session; finish or abort the current run before starting another.
