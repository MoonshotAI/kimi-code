Wait for background tasks to finish without ending the current turn.

Use only when the next step genuinely cannot proceed without a running task's result; otherwise continue other work and rely on automatic completion notifications. The call suspends the turn until a task finishes or `timeout` elapses, without making LLM requests while waiting.

The result lists completed and running tasks. Waiting never stops tasks, and user interruption leaves them running. Only tasks started by this agent can be waited on.
