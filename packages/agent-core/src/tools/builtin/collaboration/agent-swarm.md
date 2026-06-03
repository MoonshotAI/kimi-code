Launch multiple subagents from one prompt template and a list of item values.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. Do not create a JSONL file for this tool.

The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two subagents with those two concrete prompts. When a non-default subagent profile is needed, pass `subagent_type` once for the whole swarm.
