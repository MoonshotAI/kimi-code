# TTY Runner Platform Design

Date: 2026-06-12

## Goal

Build a local platform for testing and inspecting long-running Kimi TUI workflows without opening visible terminal windows.

The platform should let a developer:

- Start many hidden PTY sessions in the background.
- Drive each session with a declarative YAML workflow.
- Configure each session's command, arguments, working directory, environment, terminal columns, and terminal rows.
- Record what the PTY produced and what scripted user input was sent.
- Replay each run in a web interface, including real-time timing.
- Mark user actions and checkpoints on the replay progress bar.
- Validate simple visible text states in the TUI.

## Scope Lock

This design intentionally follows these constraints:

- Use hidden PTY sessions. Do not create real Ghostty or other desktop terminal windows.
- Do not test real terminal rendering, fonts, pixels, screenshots, or terminal-app-specific behavior.
- Do not validate color in the first version. Validation is text-only.
- Record events only. Do not record periodic screen snapshots in the first version.
- Do not add Kimi home isolation in the first version. Conflicts are acceptable, like running multiple manual terminal windows.
- Do not add security hardening in the first version.
- Do not add automatic resource scheduling or rate-limit management in the first version.
- If a run crashes or is killed, stop recording, preserve the event log, and show the final reconstructed state. Do not repair or resume broken runs.

## Architecture

The platform has four pieces:

1. **Runner**
   Starts hidden PTY processes and executes YAML scenarios.

2. **Recorder**
   Writes a timestamped event log for each run.

3. **Validator**
   Replays events into a terminal model and checks visible text.

4. **Web Inspector**
   Lists runs and replays event logs in a browser terminal player.

The existing `apps/vis` app is the preferred host for the web inspector because it already provides a Hono server and React interface for inspecting Kimi sessions.

## Run Configuration

Each run is created from a YAML file.

Example:

```yaml
name: review-current-branch

command: pnpm
args:
  - --filter
  - kimi-code
  - dev:cli-only

cwd: /Users/moonshot/Developer/kimi-code-worktrees/feat-code-review

cols: 120
rows: 36

env:
  KIMI_CODE_EXPERIMENTAL_CODE_REVIEW: "1"

steps:
  - waitForText: "How can I help?"
    timeoutMs: 30000

  - mark: "start review"

  - send: "/review\n"

  - waitForText: "What to review"
    timeoutMs: 10000

  - key: "Enter"

  - waitForText: "Review intensity"
    timeoutMs: 10000

  - key: "Enter"

  - mark: "review running"

  - waitForText: "Review completed"
    timeoutMs: 1800000

  - assertText: "Review completed"

  - mark: "done"
```

## YAML Step Types

The first version should support these declarative steps:

```yaml
- send: "literal text\n"
```

Sends literal bytes to the PTY.

```yaml
- key: "Enter"
```

Sends a named key sequence. The first version should support common keys such as `Enter`, `Escape`, `Tab`, `Backspace`, `Up`, `Down`, `Left`, `Right`, `Ctrl-C`, and `Ctrl-D`.

```yaml
- sleepMs: 1000
```

Waits for a fixed duration.

```yaml
- resize:
    cols: 140
    rows: 40
```

Resizes the PTY and records a resize event.

```yaml
- waitForText: "Review completed"
  timeoutMs: 1800000
```

Replays output into a terminal model until the visible screen contains the text, or fails on timeout.

```yaml
- assertText: "Review completed"
```

Checks that the current visible screen contains the text.

```yaml
- mark: "review running"
```

Adds a marker to the event log. Markers appear on the replay progress bar.

## Event Log

Each run writes an append-only event log. Events are timestamped relative to process start.

Required event types:

- `process_start`
- `pty_output`
- `user_input`
- `resize`
- `marker`
- `assertion`
- `process_exit`

Example:

```json
{"t":0,"type":"process_start","command":"pnpm","args":["--filter","kimi-code","dev:cli-only"],"cwd":"/repo","cols":120,"rows":36}
{"t":812,"type":"pty_output","data":"base64-encoded-bytes"}
{"t":4520,"type":"user_input","label":"send","data":"base64-encoded-bytes"}
{"t":4521,"type":"marker","label":"start review"}
{"t":927000,"type":"assertion","label":"Review completed","status":"passed"}
{"t":928100,"type":"process_exit","exitCode":0,"signal":null}
```

PTY output and user input are stored as base64 so the log can preserve arbitrary bytes.

## Storage Layout

Runs are stored under a dedicated run directory.

```text
tty-runs/
  run-abc123/
    run.json
    events.jsonl
    events.jsonl.gz
    assertions.json
```

`run.json` stores run metadata:

- Run ID.
- Scenario name.
- Scenario file path.
- Command and arguments.
- Working directory.
- Environment overrides.
- Terminal size.
- Start time.
- End time.
- Exit code or signal.
- Final status: `running`, `passed`, `failed`, `killed`, or `crashed`.

`events.jsonl` is written while the process is active. After the run ends, it may be compressed to `events.jsonl.gz` in the background. The uncompressed file can be removed after compression succeeds.

`assertions.json` stores assertion summaries for fast list views. The source of truth remains the event log.

## Replay

The web player replays events in timestamp order.

Replay behavior:

- PTY output events are written into a browser terminal emulator.
- User input events are shown as progress-bar markers and optional inline annotations.
- Marker events are shown on the progress bar.
- Assertion events are shown on the progress bar with pass or fail status.
- Resize events resize the browser terminal model at the correct replay time.
- Process exit is shown as the terminal state.

Replay should support:

- Play and pause.
- Speed control.
- Jump to marker.
- Jump to assertion.
- Jump to start or end.
- Show final screen.
- Show raw event details around the current replay time.

The first version does not need fast arbitrary seeking. If a user jumps to a late point in a long run, the player may replay events from the start to reconstruct that point.

## Validation

Validation is text-only in the first version.

The validator should maintain a terminal model while the scenario runs. `waitForText` and `assertText` inspect the model's current visible text.

Validation should not inspect raw output directly because raw PTY bytes include cursor movement, redraws, alternate screen control, and other ANSI sequences.

Validation output:

- Step index.
- Expected text.
- Pass or fail.
- Timestamp.
- Timeout, if applicable.
- Current visible screen text on failure.

## Process Handling

The runner starts each command under a PTY. The process runs hidden in the background.

If the scenario completes and the process is still alive, the run may either leave it running or terminate it based on a scenario option:

```yaml
onScenarioComplete: terminate
```

Allowed values:

- `terminate`
- `leaveRunning`

If the process crashes or is killed:

- Record `process_exit`.
- Stop executing scenario steps.
- Mark the run failed, killed, or crashed.
- Preserve the event log.
- Show the final reconstructed terminal state in the web UI.

No repair or resume flow is included.

## Web API

Add TTY run routes to the Vis server.

Suggested routes:

- `GET /api/tty-runs`
- `POST /api/tty-runs`
- `GET /api/tty-runs/:id`
- `GET /api/tty-runs/:id/events`
- `POST /api/tty-runs/:id/stop`

`POST /api/tty-runs` accepts a scenario file path or inline YAML. The first version can support file paths only if that is simpler.

## Web UI

Add a TTY Runs area to the Vis web app.

Views:

1. **Run List**
   Shows run ID, scenario name, status, command, cwd, start time, duration, exit code, and assertion summary.

2. **Run Detail**
   Shows metadata, event counts, assertion results, and replay player.

3. **Replay Player**
   Shows a terminal replay with timeline markers for user input, explicit marks, assertions, resize events, and process exit.

## Implementation Phases

1. Add scenario schema and YAML parser.
2. Add PTY runner that can start one hidden process.
3. Add event recorder with `process_start`, `pty_output`, `user_input`, `resize`, `marker`, `assertion`, and `process_exit`.
4. Add YAML step executor for `send`, `key`, `sleepMs`, `resize`, `waitForText`, `assertText`, and `mark`.
5. Add text-only validation against a terminal model.
6. Add run storage and background gzip compression after completion.
7. Add Vis API routes for listing runs, reading run metadata, reading event logs, and stopping runs.
8. Add Vis web run list and run detail pages.
9. Add browser terminal replay with progress markers.
10. Add one sample code-review scenario.

## Acceptance Criteria

- A developer can start a hidden Kimi TUI session from a YAML scenario.
- The scenario can type commands and press keys without manual interaction.
- The run records timestamped PTY output and scripted user input.
- The web UI can replay the run in timing order.
- User input, explicit marks, assertions, resize events, and process exit are visible on the replay timeline.
- `waitForText` can wait for text on the visible terminal screen.
- `assertText` can validate text on the visible terminal screen.
- Failed assertions preserve the final visible text for inspection.
- A crashed or killed run preserves its event log and final reconstructed screen.

## Explicit Non-Goals

- No real Ghostty automation.
- No pixel validation.
- No color validation.
- No screenshot recording.
- No periodic screen snapshots.
- No Kimi home isolation.
- No security hardening.
- No automatic concurrency or rate-limit management.
- No crashed-session repair.
- No session resume for broken TTY runs.
