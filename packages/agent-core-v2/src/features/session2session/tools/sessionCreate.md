Create a new peer session or fork an existing session with its history, and optionally submit its first task.

Without forkFrom, creates a fresh session using cwd (default: the current session cwd) and optional title. With forkFrom, uses the core fork facility to preserve the source session's history and working directory; forkFrom accepts an id or exact title and cannot be archived. Duplicate titles return candidates; retry with the chosen id.

prompt is optional. When present, it is submitted as the new session's first user task. The result contains sessionId and status=created, plus promptId and promptStatus when prompt was submitted. The first task starts immediately when the new session is idle or queues when necessary.

Manager pattern: create a worker with an initial prompt, discover it later with session_list, then use session_send(expectReply=true) for follow-up work. Workers answer with session_send(replyTo=received messageId). Managers can also use session_read to pull the latest assistant output without opening the full transcript.

This tool creates peer sessions with independent contexts, not subagents. Use Agent for shared-context lightweight subtasks and Agent with fork when a child should inherit the current conversation without requiring session management tools.
