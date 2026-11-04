Read only the current status and latest assistant text output of another session in this daemon.

to accepts a session id or exact title. Duplicate titles return candidates; retry with the chosen id. The result contains id, title, status, and latestAssistant when text output exists. latestAssistant is truncated to limit characters (default 2000, maximum 10000); this tool never returns the full transcript.

Use it when a manager wants to pull a worker's latest result without waiting or reopening the whole conversation. It complements asynchronous session_send replies rather than replacing them. Workers should still return results with session_send(replyTo=received messageId) so the manager is woken automatically.

The lookup is read-only: archived sessions and sessions occupied by another process are read without error and without resuming or unarchiving them. An unknown session id or title is an error.
