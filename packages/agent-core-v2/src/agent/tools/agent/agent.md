Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file.

Do not launch a subagent unless the user explicitly asks for one. Each subagent starts cold and re-derives context you already have, which costs the user time and tokens. Asking means: the user asks for a subagent, delegation, or parallel agents, or requests one of the agent types below by name (for example "use an explore agent"). Explicit instructions in AGENTS.md or a skill, and a multi-agent mode the user turned on (such as swarm or tower mode), also count. Nothing else does: a large or multi-part task, or a request for depth, thoroughness, research, or investigation, is not a request to launch — do that work yourself with your own tools. The agent type descriptions below only help you choose a type once launching is authorized; they never authorize it. Resuming a subagent to continue already-authorized work needs no new request.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.
