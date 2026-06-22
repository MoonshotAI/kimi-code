Run a self-filtering shell command in the background and receive each new stdout line as a real-time notification.

Use `Monitor` to watch long-running processes, log files, or build/test output without blocking the conversation. The command should produce one line per event you care about.

**How to design a good monitor command:**
- Self-filter on the shell side so stdout only contains meaningful events. Examples:
  - `tail -F app.log | grep --line-buffered "ERROR"`
  - `python -u server.py 2>&1 | grep --line-buffered "Traceback\|Error"`
  - `awk '/pattern/ {print; fflush()}' <(tail -F log.txt)` — always flush per line.
- Ensure line buffering. Tools like `grep` default to line buffering only when writing to a terminal; force it with `--line-buffered`. In `awk`, call `fflush()` after each `print`.
- Silence is not success. If the filter stops matching, the monitor simply emits nothing. Include failure signatures in the filter when relevant, e.g. `Traceback|Error|FAILED|Killed|OOM`.
- Keep output sparse. The monitor auto-stops with a warning if it emits more than 200 lines in a 5-second window. If that happens, tighten the filter and start again.

**Lifecycle:**
- `timeout_ms` defaults to 5 minutes and is ignored when `persistent=true`.
- `persistent=true` runs until the session ends or you call `TaskStop`.
- Stop any monitor early with `TaskStop(task_id="...")`.

**Output:**
The tool returns immediately with a `task_id`. Each matching stdout line arrives later as a `<notification type="monitor_line">` injection.
