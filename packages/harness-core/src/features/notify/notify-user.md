Show the end user a progress update without ending your turn. Main-agent and subagent updates appear together in the TUI's Updates panel, with source labels added automatically. The panel keeps every update in order until the main agent starts a new turn. It remains visible when work ends, and the user can page through the complete messages.

**When to use:**
1. Early in a multi-step task, describe your approach so the user can follow your work.
2. Report meaningful findings and phase conclusions, distinguishing confirmed results from hypotheses.
3. Before a long-running step, say what you are waiting for and why.
4. When blocked, explain the blocker and your next step.

**How to use:**
- Write the way you would update a colleague in chat, in the end user's language, in light Markdown. Give each update a two-part layout: open with a short flowing paragraph (two to four sentences — the conclusion and the evidence behind it), then put the details into structure — a few bullet points, short separated paragraphs, or key-value lines with file paths and error excerpts. Avoid tables and wide code blocks; the panel is narrower than the chat. Keep the whole update under roughly 1000 characters, self-contained enough to read on its own page. Avoid repeating unchanged status or narrating individual tool calls.
- When working as a subagent, describe only your own subtask. Its completion does not mean the whole task is complete.
- Do not add an agent name or source prefix; the UI supplies it.
- Batch the update with your next tool calls when possible.
- This tool informs the end user; it does not automatically send a message to your parent agent. Keep all important findings in your final reply or final handoff to the parent.
- Do not use an update to ask questions, request decisions, or deliver the final answer. Subagents must leave questions for the parent agent in their handoff.
