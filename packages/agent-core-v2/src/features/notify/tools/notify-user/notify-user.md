Show the end user a progress update without ending your turn. Main-agent and subagent updates are shown to the user as they arrive, with source labels added automatically. The title is shown on its own wherever space is tight, such as a status line or a session list, and the user can open the full message from it. Updates stay visible after the work ends.

**When to use:**
1. Early in a multi-step task, describe your approach so the user can follow your work.
2. Report meaningful findings and phase conclusions, distinguishing confirmed results from hypotheses.
3. Before a long-running step, say what you are waiting for and why.
4. When blocked, explain the blocker and your next step.

**How to use:**
- Make the `title` a single line that stands on its own: the conclusion or the current phase, in the end user's language, under roughly 60 characters, in plain text without Markdown or a trailing period.
- Put the details behind the title in `message`, without repeating the title. Write the way you would update a colleague in chat, in the end user's language, in light Markdown: open with a short flowing paragraph (two to four sentences — the evidence and reasoning behind the title), then put the details into structure — a few bullet points, short separated paragraphs, or key-value lines with file paths and error excerpts. Avoid tables and wide code blocks; updates can be shown in a narrow column. Keep the message under roughly 1000 characters, self-contained enough to read on its own. Avoid repeating unchanged status or narrating individual tool calls.
- When working as a subagent, describe only your own subtask. Its completion does not mean the whole task is complete.
- Do not add an agent name or source prefix; the UI supplies it.
- Batch the update with your next tool calls when possible.
- This tool informs the end user; it does not automatically send a message to your parent agent. Keep all important findings in your final reply or final handoff to the parent.
- Do not use an update to ask questions, request decisions, or deliver the final answer. Subagents must leave questions for the parent agent in their handoff.
