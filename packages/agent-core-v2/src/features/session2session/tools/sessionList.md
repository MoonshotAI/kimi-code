List peer sessions available to session_send in this daemon.

Returns id, title, cwd, status, and dir for each session. dir is the absolute session directory; read its agents/main/wire.jsonl (or another agent's wire file) only when the existing conversation artifacts are needed. Status is idle, running, queued, or archived. Use session_send with an id or exact title; if a title is duplicated, choose a candidate id instead.

Use the optional filter as a case-insensitive substring over id, title, cwd, status, and dir. A manager can discover existing peers before assigning asynchronous work with session_send(expectReply=true), then aggregate later replies and continue scheduling. Workers use session_send(replyTo=received messageId) to return results. Notifications with expectReply=false do not require replies; do not create courtesy reply loops.

Related orchestration tools:
- session_create creates a fresh peer or forks a session with history and can submit its first task.
- session_read returns status and only the latest assistant text output when a manager needs to pull a result without opening the full transcript.
- session_send(delivery=steer) is reserved for urgent real-time correction of an active turn; normal work uses the default queue.

This tool discovers existing peer sessions, not subagents or forked child contexts.
