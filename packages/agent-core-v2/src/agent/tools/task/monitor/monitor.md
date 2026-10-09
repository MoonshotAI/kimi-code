Start a background monitor: a shell command whose stdout lines are delivered to you as notifications while you keep working. Use it to react to something as soon as it happens — a log line, a test failure, a server becoming ready, a CI status change — instead of polling with Bash sleep loops or blocking in WaitFor.

How it works:

- The command runs in the background, like Bash with `run_in_background=true`. Each stdout line is an event; lines that arrive close together are batched into one notification.
- While you are working, events arrive at your next step. While you are idle, an event starts a new turn. Every notification costs a model call and stays in the conversation, so print only the lines you need to react to.
- stderr is not delivered as events. It is kept in the task output, which TaskOutput reads.
- The monitor stops when the command exits, when `timeout` passes (default ${DEFAULT_TIMEOUT_S}s, max ${MAX_TIMEOUT_S}s), or when you call TaskStop. With `persistent: true` it runs until TaskStop or the end of the session. You are notified when it stops.
- A monitor that prints more than ${MAX_LINES_PER_MINUTE} lines in a minute is stopped automatically.
- WaitFor with a monitor's `task_id` returns as soon as its next event is ready. WaitFor without a `task_id` does not wait for monitors.

Writing the command:

- Filter at the source, and keep pipes line-buffered: `tail -F app.log | grep --line-buffered -E "ERROR|listening on"`. Without `--line-buffered` (or `stdbuf -oL`, `awk` with `fflush()`), output arrives late and in large chunks.
- Match failure signals as well as the success you expect. If you watch for "Build succeeded", also match "error|failed|Traceback", or a crash stays silent until the timeout.
- To watch a changing state, poll in a loop and print only when it changes: `prev=""; while true; do s=$(gh pr checks 123 2>&1 | grep -c pending); [ "$s" != "$prev" ] && echo "pending checks: $s"; prev=$s; sleep 30; done`.
- Do not use Monitor just to learn when one command finishes: run it with Bash `run_in_background=true` and you are notified on completion.
- Check TaskList before starting a monitor so you do not run duplicates, and stop monitors you no longer need with TaskStop.

The tool returns the monitor's task id right away.
