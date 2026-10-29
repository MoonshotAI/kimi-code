Show the end user a progress update without ending your turn. Main-agent and subagent updates are shown to the user as they arrive, with source labels added automatically. The title is shown on its own wherever space is tight, and the user can open the full message from it. Updates stay visible after the work ends.

**When to use:**
1. Early in a multi-step task, describe your approach so the user can follow your work.
2. Report meaningful findings and phase conclusions, distinguishing confirmed results from hypotheses.
3. Before a long-running step, say what you are waiting for and why.
4. When blocked, explain the blocker and your next step.

**How to use:**
- Write the `title` without Markdown or a trailing period.
- Write the `message` the way you would update a colleague in chat: open with two to four sentences of evidence and reasoning, then give details as bullet points, short paragraphs, or key-value lines with file paths and error excerpts. Avoid tables and wide code blocks; updates can be shown in a narrow column. Keep it self-contained, and avoid repeating unchanged status or narrating individual tool calls.
- When working as a subagent, describe only your own subtask. Its completion does not mean the whole task is complete.
- Do not add an agent name or source prefix; the UI supplies it.
- Batch the update with your next tool calls when possible.
- This tool informs the end user; it does not automatically send a message to your parent agent. Keep all important findings in your final reply or final handoff to the parent.
- Do not use an update to ask questions, request decisions, or deliver the final answer. Subagents must leave questions for the parent agent in their handoff.
