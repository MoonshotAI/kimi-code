Record a confirmed finding, with evidence providing verifiable proof such as command output and logs. In a task context, pass the current `intent_id`. The returned `finding_node_id` is the exploration node ID.

- `vulnclass`: vulnerability class. `name`: vulnerability name. `severity`: `critical|high|medium|low`. `summary`: finding summary.
- `intent_id`: the current task's intent id. `asset_ids`: affected asset ids.
- `evidence`: evidence/PoC text — the command and the key output lines that prove the conclusion.
- `counterevidence` (optional): what you tested that did NOT work (variants, paths, or bypasses that were blocked or came back negative). Fill it when your confidence is not high; omitting it never blocks reporting.
- `confidence_rationale` (optional): why you are confident this is a real, exploitable issue rather than a false positive.

Report only findings you have actually confirmed. Before reporting, check this task's existing findings (list_findings) to avoid reporting the same finding twice. Traffic-evidence binding and the verified/poe_level assessment are performed later by the evidence pipeline; keep your verification commands and key output in `evidence` so they can be traced.
