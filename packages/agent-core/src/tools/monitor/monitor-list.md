List this session's monitors and their status.

Each record shows `id`, `type`, `status`, `timeoutS`, `ageS`, the watched target (task id / command / path), and — for fired monitors — the `trigger` (`match`, `exit`, or `timeout`).

Status meanings:

- `active` — watching; will fire on match, exit, or timeout.
- `fired` — already delivered its one notification (monitors are one-shot).
- `cancelled` — cancelled via MonitorCancel.
- `ended` — a `task_output` monitor whose watched task finished without a match (no notification was sent, by design).
- `lost` — was active when the previous session process exited; not re-attached after resume. Re-create with MonitorCreate if still needed.

The empty case returns `monitors: 0\nNo monitors registered.`.
