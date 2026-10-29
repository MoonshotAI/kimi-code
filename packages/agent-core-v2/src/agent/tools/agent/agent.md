Launch a subagent to handle a task in its own context.

Launch one only when the user asks for it — delegation, parallel agents, or a named agent type — when AGENTS.md or a skill says to, or in a multi-agent mode the user turned on. A large task or a request for depth or thoroughness is not by itself such a request, and resuming already-authorized work needs no new one. The agent type descriptions below help choose a type once launching is authorized. Each subagent starts cold and re-derives context, which costs time and tokens.

The subagent has not seen this conversation. Give it the goal and what you already know, including exact paths and commands; for an investigation, give the question rather than prescribed steps.

- To continue work a subagent already did, resume it with its `resume` id; it keeps its prior context.
- Only you see a subagent's result; summarize what the user needs in your own reply.
- While a subagent runs, don't redo its work in parallel or abandon it midway to finish by hand; both waste what the delegation saved.
