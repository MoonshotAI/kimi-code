Launch multiple subagents from a JSONL agents file. This tool is for avoiding manually writing out many similar subagent prompts.

Before calling AgentSwarm, generate the `agents_file` in a temporary directory with a code script. The JSONL file must be produced programmatically, and the script must use a loop to generate the agents instead of hard-coding every agent. DO NOT hand-write the JSONL file.

The agents file:
- A file must define more than 3 subagents, no upper limit.
- Each line must be one JSON object with `prompt` and optional `subagent_type`.
- `prompt` is the task prompt sent as that subagent's first user message.
- `subagent_type` is one of the available subagent types, such as `coder`, `explore`, or `plan`. It defaults to `coder` when omitted.
