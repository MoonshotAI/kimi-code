# Headless Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated non-TUI command surface for programmatic users and coding agents.

**Architecture:** Keep headless mode turn-based. Implement `kimi headless run` as a separate command surface from `kimi -p`. Use the current SDK, session, and event APIs. Do not change `-p` behavior, output, validation, or option names.

**Tech Stack:** TypeScript, Commander.js, Vitest, Kimi Code SDK session events. Keep the current tech stack as much as possible. Do not add runtime dependencies unless the existing stack cannot solve the problem.

---

## Reader Outcome

After this plan, a program can run one Kimi Code turn without a TUI.

The command shall be clear from `--help` alone.

The command shall expose enough state for another process to monitor a long turn.

The CLI shall stop when the turn ends.

The existing `kimi -p` prompt mode shall remain unchanged.

## Current Code Facts

- `apps/kimi-code/src/cli/run-prompt.ts` already runs one prompt without the TUI.
- `kimi -p "..."` selects `uiMode: 'print'` through `validateOptions`.
- `runPromptTurn` listens to session events and stops on `turn.ended`.
- `--output-format` currently belongs to prompt mode and supports `text` and `stream-json`.
- Headless prompt mode currently installs approval and question handlers.
- `KimiHarness` and `Session` already expose `listSessions`, `createSession`, `resumeSession`, `getStatus`, `getUsage`, `cancel`, `prompt`, `steer`, and events.
- `apps/kimi-code` may only use core capabilities through `@moonshot-ai/kimi-code-sdk`.

## Non-Goals

- Do not modify `kimi -p`.
- Do not extend `--output-format`.
- Do not make daemon mode part of this slice.
- Do not add a new runtime dependency for locking, file writes, or JSON framing.
- Do not auto-approve plan exit by default.

## CLI Contract

Keep existing prompt mode unchanged:

```sh
kimi -p "summarize this repository"
```

Add a dedicated command group:

```sh
kimi headless run --prompt "summarize this repository"
kimi headless run --cwd /repo --prompt "fix the failing test"
kimi headless run --prompt "fix the failing test" --status-file /tmp/kimi-run.json
kimi headless run --prompt "fix the failing test" --output-dir /tmp/kimi-run
kimi headless run --prompt "inspect" --metadata-only
kimi headless run --prompt "apply this plan" --approve-plan
kimi headless run --prompt "review this plan" --reject-plan
kimi headless --goal "ship the refactor" --status-file /tmp/kimi-run/status.json
kimi headless run --goal "ship the refactor" --output-dir /tmp/kimi-run
kimi headless run --replace-goal "ship the refactor"
kimi headless goal pause --file /tmp/kimi-run/status.json
kimi headless goal cancel --file /tmp/kimi-run/status.json
kimi headless goal interrupt --file /tmp/kimi-run/status.json
kimi headless status --file /tmp/kimi-run.json --json
```

`kimi headless --help` shall explain that headless mode runs one turn and exits.

`kimi headless run --help` shall show examples for:

- a default JSON metadata header plus Markdown response
- metadata-only output
- a status file
- file output with `--output-dir`
- a custom working directory
- plan approval
- goal-backed execution
- goal pause, cancel, and interrupt control

`kimi headless status --help` shall explain that it reads a status file written by `headless run`.

`kimi headless run` shall support these options:

- `--prompt <prompt>`: prompt text.
- `--goal <objective>`: create a goal and run until it reaches a terminal state.
- `--replace-goal <objective>`: replace the active goal and run until it reaches a terminal state.
- `--cwd <dir>`: working directory for a new session, `--continue`, or session workdir validation.
- `--session <id>`: resume a specific session.
- `--continue`: continue the latest session for the working directory.
- `--model <model>`: override the model for this run.
- `--status-file <path>`: write atomic run status updates to a JSON file.
- `--output-dir <dir>`: write response Markdown and goal metadata files to a directory.
- `--metadata-only`: print only the JSON metadata line and omit the Markdown response body.
- `--approve-plan`: approve plan-exit requests only.
- `--reject-plan`: reject plan-exit requests by selecting the existing `Reject and Exit` plan-review choice.
- `--skills-dir <dir>`: reuse the existing repeatable skill directory option.

`kimi headless run` shall not support `--output-format`.

`kimi headless run` shall always print a JSON metadata header by default.

`kimi headless --goal <objective>` shall be a shortcut for `kimi headless run --goal <objective>`.

The shortcut shall accept the same run options that make sense for a goal-backed run, including `--cwd`, `--session`, `--continue`, `--model`, `--status-file`, `--output-dir`, `--metadata-only`, `--approve-plan`, `--reject-plan`, and `--skills-dir`.

Every run shall include exactly one of `--prompt`, `--goal`, or `--replace-goal`.

`--prompt`, `--goal`, and `--replace-goal` shall be mutually exclusive.

`kimi headless goal` shall support these subcommands:

- `pause --file <path>`: request a graceful pause after the current turn finishes.
- `cancel --file <path>`: request graceful goal cancellation after the current turn finishes.
- `interrupt --file <path>`: request immediate interruption of the active turn and leave the goal paused when possible.

Each subcommand shall support `--wait`.

With `--wait`, the command shall wait until the running process records the command id in `control.lastApplied`.

## Existing `-p` Contract

`kimi -p` is an existing shortcut with existing output contracts.

This plan shall not change:

- accepted options for `-p`
- `--output-format=text`
- `--output-format=stream-json`
- prompt-mode validation errors
- prompt-mode telemetry labels
- prompt-mode stdout or stderr layout

Implementation may copy small logic from `run-prompt.ts`.

Implementation may extract shared code only after regression tests prove `kimi -p` output and validation do not change.

## Working Directory Contract

`--cwd <dir>` shall resolve to an absolute path before session lookup or session creation.

If `--cwd` is omitted, use `process.cwd()`.

For a new session:

- use the resolved cwd as `workDir`
- include the resolved cwd in the status file and JSON header

For `--continue`:

- list sessions for the resolved cwd
- resume the newest session for that cwd
- fail if no session exists for that cwd

For `--session <id>`:

- list the target session
- if `--cwd` is present and differs from the session workdir, fail before resuming
- if `--cwd` is omitted, use the session workdir from the session summary

The help text shall state that `--cwd` selects or validates the session workspace.

## Session Lock Contract

Headless mode should prevent two local `kimi` processes from running the same session at the same time.

Use a lock file in the session directory:

```text
<sessionDir>/run.lock
```

Acquire the lock with atomic file create:

```ts
await open(lockPath, 'wx');
```

The lock file shall contain:

```json
{
  "schemaVersion": 1,
  "runId": "run_123",
  "pid": 12345,
  "createdAt": "2026-06-05T00:00:00.000Z",
  "command": "headless run"
}
```

Lock behavior:

- For `--session` and `--continue`, acquire the lock before `resumeSession`.
- For a new session, acquire the lock after `createSession` returns and before sending the prompt.
- Release the lock after the turn ends or after startup failure.
- If the lock exists and its pid is alive, fail with `SESSION_LOCKED`.
- If the lock exists and its pid is not alive, remove it and acquire a new lock.
- If the lock cannot be created or removed, fail before sending the prompt.

The helper shall live in the SDK.

The helper shall stay independent of CLI concerns so the later TUI and daemon locking work can reuse the same primitive.

## Status File Contract

`headless run --status-file <path>` shall preflight the status file before creating or resuming a session.

Preflight rules:

- If the parent directory does not exist, fail before creating or resuming a session.
- If the parent path is not writable, fail before creating or resuming a session.
- If the status file already exists, overwrite it through atomic replace.
- If `<path>.tmp` exists from an old run, overwrite it.

`headless run --status-file <path>` shall write JSON with this shape:

```json
{
  "schemaVersion": 1,
  "runId": "run_123",
  "pid": 12345,
  "sessionId": "ses_123",
  "turnId": 7,
  "state": "running",
  "workDir": "/repo",
  "model": "kimi-code/k2.5",
  "startedAt": "2026-06-05T00:00:00.000Z",
  "updatedAt": "2026-06-05T00:00:05.000Z",
  "elapsedMs": 5000,
  "lastEvent": "tool.call.started",
  "activeTool": {
    "toolCallId": "call_123",
    "name": "functions.exec_command",
    "description": "Run tests"
  },
  "summary": {
    "turnStepCount": 2,
    "toolCallCount": 3,
    "completedToolCallCount": 2,
    "failedToolCallCount": 0,
    "assistantCharCount": 1520,
    "thinkingCharCount": 430
  },
  "approval": null,
  "goal": null,
  "warnings": [],
  "files": {
    "outputDir": null,
    "responses": [],
    "finalResponse": null,
    "goalStatus": null
  },
  "control": null,
  "error": null,
  "resumeCommand": "kimi -r ses_123"
}
```

For goal-backed runs, `goal` shall be non-null:

```json
{
  "goal": {
    "goalId": "goal_123",
    "status": "complete",
    "reason": "Objective achieved.",
    "turnsUsed": 3,
    "tokensUsed": 12000,
    "wallClockMs": 45000
  }
}
```

For runs that write response files, `files` shall list every caller-visible artifact:

```json
{
  "files": {
    "outputDir": "/tmp/kimi-run",
    "responses": [
      {
        "turnIndex": 1,
        "turnId": 7,
        "path": "/tmp/kimi-run/turns/turn-0001.md",
        "state": "completed",
        "bytes": 4210,
        "updatedAt": "2026-06-05T00:00:10.000Z"
      },
      {
        "turnIndex": 2,
        "turnId": 8,
        "path": "/tmp/kimi-run/turns/turn-0002.md",
        "state": "completed",
        "bytes": 2832,
        "updatedAt": "2026-06-05T00:00:25.000Z"
      }
    ],
    "finalResponse": {
      "turnIndex": 2,
      "turnId": 8,
      "path": "/tmp/kimi-run/turns/turn-0002.md",
      "state": "completed",
      "bytes": 2832,
      "updatedAt": "2026-06-05T00:00:25.000Z"
    },
    "goalStatus": {
      "path": "/tmp/kimi-run/goal-status.json",
      "state": "completed",
      "bytes": 168,
      "updatedAt": "2026-06-05T00:00:25.000Z"
    }
  }
}
```

For goal-backed runs, `control` shall be non-null while the process is running:

```json
{
  "control": {
    "path": "/tmp/kimi-run/control.json",
    "supportedActions": ["pause_goal", "cancel_goal", "interrupt"],
    "lastRequest": null,
    "lastApplied": null
  }
}
```

Callers shall only read response files with `state: "completed"`.

The status writer shall update `files` only after the target file has been atomically renamed into place.

Allowed `state` values:

- `starting`
- `running`
- `approval_required`
- `paused`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

The writer shall use an atomic replace:

1. Write `<path>.tmp`.
2. Flush the full JSON text.
3. Rename `<path>.tmp` to `<path>`.

If the CLI exits through `SIGINT` or `SIGTERM`, it shall update the status file to `cancelled` before process exit when possible.

## Output File Contract

`--output-dir <dir>` shall write caller-readable artifacts to a directory.

If `--output-dir` is omitted and `--status-file <path>` is present, derive the output directory as `<path>.d`.

If both `--output-dir` and `--status-file` are omitted, create a run-specific directory under the OS temp directory.

The final stdout metadata shall always include the resolved output directory when files are written.

For goal-backed runs, headless mode shall always write response files.

For non-goal runs, headless mode shall write response files only when `--output-dir` is set.

Preflight rules:

- If the output directory does not exist, create it before creating or resuming a session.
- If the output directory path exists and is not a directory, fail before creating or resuming a session.
- If the output directory is not writable, fail before creating or resuming a session.
- Create `turns/` before sending the prompt.
- If a target response file already exists, overwrite it through atomic replace.
- If a target temp file exists from an old run, overwrite it.

Goal-backed directory layout:

```text
<outputDir>/
  turns/
    turn-0001.md
    turn-0002.md
  control.json
  goal-status.json
```

File rules:

- Write assistant Markdown for each completed turn to `turns/turn-XXXX.md`.
- Do not add generated headings, separators, or status blocks to response Markdown files.
- Treat Markdown files as opaque model output.
- Write goal status to `goal-status.json` for goal-backed runs.
- Write every file atomically with a temp file and rename.
- Update the status file after the final path exists.
- Never list temp files in status JSON.

For goal-backed runs, stdout shall not include Markdown.

For goal-backed runs, callers shall read turn response files from `files.responses` and goal state from `goal` or `files.goalStatus`.

Active monitoring contract:

- Callers shall poll `headless status --file <path> --json` or read the status file directly.
- Callers shall discover output files only through `files`.
- Callers shall not scan the output directory to infer run state.
- Callers shall read a response file only after its status entry has `state: "completed"`.
- Callers shall treat response Markdown as opaque content.

## Goal Control Contract

Headless goal control shall use a control file owned by the running process.

The running process remains the only process that owns the session lock.

Callers shall send control requests by writing the control file path listed in `status.control.path`.

Control request shape:

```json
{
  "schemaVersion": 1,
  "runId": "run_123",
  "commandId": "cmd_001",
  "action": "pause_goal",
  "requestedAt": "2026-06-05T00:00:20.000Z"
}
```

Allowed `action` values:

- `pause_goal`
- `cancel_goal`
- `interrupt`

Control request writes shall be atomic:

1. Write `<controlPath>.tmp`.
2. Flush the full JSON text.
3. Rename `<controlPath>.tmp` to `<controlPath>`.

`pause_goal` behavior:

- Record the request in `control.lastRequest`.
- Apply the pause request when the control file is read.
- Let the current turn keep running.
- Do not call `session.cancel()` for this action.
- Do not schedule another goal turn after the current turn ends.
- Write final status with `state: "paused"`.
- Leave the goal resumable.
- Exit with the existing paused goal exit code.
- Match the TUI `/goal pause` user experience.
- Do not use the word "pause" for immediate turn interruption.

`cancel_goal` behavior:

- Record the request in `control.lastRequest`.
- Let the current turn finish.
- Do not call `session.cancel()` for this action.
- Before scheduling the next goal turn, call `session.cancelGoal()`.
- Write final status with `state: "cancelled"`.
- Do not schedule more goal turns.

`interrupt` behavior:

- Record the request in `control.lastRequest`.
- Stop the active turn as soon as possible.
- Call `session.pauseGoal()` when a goal is active.
- Call `session.cancel()` to interrupt the active turn.
- Write final status with `state: "interrupted"`.
- Leave the goal resumable when `pauseGoal()` succeeds.
- Exit with the existing paused goal exit code.
- Use this action for the behavior that stops the active turn immediately.

After applying any control request, write `control.lastApplied` with:

```json
{
  "commandId": "cmd_001",
  "action": "pause_goal",
  "appliedAt": "2026-06-05T00:00:30.000Z",
  "result": "applied"
}
```

If a control request cannot be applied, write `control.lastApplied.result: "failed"` with an error message.

The helper command `--wait` mode shall poll the status file until `control.lastApplied.commandId` matches its command id or the run reaches a terminal state.

## Output Contract

Default stdout shall start with one JSON metadata line.

For non-goal runs without `--output-dir`, the metadata line shall be followed by one blank line and the final assistant response as verbatim Markdown:

```text
{"type":"headless.result","schemaVersion":1,"runId":"run_123","sessionId":"ses_123","turnId":7,"state":"completed","responseFormat":"markdown","responseOmitted":false,"resumeCommand":"kimi -r ses_123","summary":{"toolCallCount":3,"completedToolCallCount":3,"failedToolCallCount":0,"turnStepCount":2,"assistantCharCount":1520,"thinkingCharCount":430,"elapsedMs":5000},"approval":null,"goal":null,"warnings":[],"files":{"outputDir":null,"responses":[],"finalResponse":null,"goalStatus":null}}

The assistant response starts here as Markdown.
```

Do not put the full assistant response inside a JSON string.

For non-goal runs with `--output-dir`, stdout shall contain only the metadata line and list the response file:

```text
{"type":"headless.result","schemaVersion":1,"runId":"run_123","sessionId":"ses_123","turnId":7,"state":"completed","responseFormat":"files","responseOmitted":true,"resumeCommand":"kimi -r ses_123","summary":{"toolCallCount":3,"completedToolCallCount":3,"failedToolCallCount":0,"turnStepCount":2,"assistantCharCount":1520,"thinkingCharCount":430,"elapsedMs":5000},"approval":null,"goal":null,"warnings":[],"files":{"outputDir":"/tmp/kimi-run","responses":[{"turnIndex":1,"turnId":7,"path":"/tmp/kimi-run/turns/turn-0001.md","state":"completed","bytes":4210,"updatedAt":"2026-06-05T00:00:10.000Z"}],"finalResponse":{"turnIndex":1,"turnId":7,"path":"/tmp/kimi-run/turns/turn-0001.md","state":"completed","bytes":4210,"updatedAt":"2026-06-05T00:00:10.000Z"},"goalStatus":null}}
```

For goal-backed runs, stdout shall contain only the metadata line.

For goal-backed runs, response files shall be listed in `files.responses`:

```text
{"type":"headless.result","schemaVersion":1,"runId":"run_123","sessionId":"ses_123","turnId":8,"state":"completed","responseFormat":"files","responseOmitted":true,"resumeCommand":"kimi -r ses_123","summary":{"toolCallCount":3,"completedToolCallCount":3,"failedToolCallCount":0,"turnStepCount":2,"assistantCharCount":1520,"thinkingCharCount":430,"elapsedMs":5000},"approval":null,"goal":{"goalId":"goal_123","status":"complete","reason":"Objective achieved.","turnsUsed":2,"tokensUsed":12000,"wallClockMs":45000},"warnings":[],"files":{"outputDir":"/tmp/kimi-run","responses":[{"turnIndex":1,"turnId":7,"path":"/tmp/kimi-run/turns/turn-0001.md","state":"completed","bytes":4210,"updatedAt":"2026-06-05T00:00:10.000Z"},{"turnIndex":2,"turnId":8,"path":"/tmp/kimi-run/turns/turn-0002.md","state":"completed","bytes":2832,"updatedAt":"2026-06-05T00:00:25.000Z"}],"finalResponse":{"turnIndex":2,"turnId":8,"path":"/tmp/kimi-run/turns/turn-0002.md","state":"completed","bytes":2832,"updatedAt":"2026-06-05T00:00:25.000Z"},"goalStatus":{"path":"/tmp/kimi-run/goal-status.json","state":"completed","bytes":168,"updatedAt":"2026-06-05T00:00:25.000Z"}}}
```

`--metadata-only` shall omit the Markdown response body:

```text
{"type":"headless.result","schemaVersion":1,"runId":"run_123","sessionId":"ses_123","turnId":7,"state":"completed","responseFormat":"omitted","responseOmitted":true,"resumeCommand":"kimi -r ses_123","summary":{"toolCallCount":3,"completedToolCallCount":3,"failedToolCallCount":0,"turnStepCount":2,"assistantCharCount":1520,"thinkingCharCount":430,"elapsedMs":5000},"approval":null,"goal":null,"warnings":[],"files":{"outputDir":null,"responses":[],"finalResponse":null,"goalStatus":null}}
```

When the run fails before a Markdown response exists, stdout shall contain one metadata line:

```text
{"type":"headless.result","schemaVersion":1,"runId":"run_123","sessionId":"ses_123","turnId":7,"state":"failed","responseFormat":"omitted","responseOmitted":true,"error":{"message":"PROVIDER_ERROR: request failed"}}
```

Default stderr may contain progress, warnings, and errors.

This plan shall not add event JSONL output.

Event stream output belongs to a later daemon or session-inspection design.

## Goal Mode Contract

`kimi headless` shall support a dedicated goal option.

Supported first-slice commands:

```sh
kimi headless --goal "ship the refactor"
kimi headless run --goal "ship the refactor"
kimi headless run --replace-goal "ship the refactor"
```

Use the existing goal creation, goal replacement, and goal exit-code behavior from `apps/kimi-code/src/cli/goal-prompt.ts`.

Goal behavior:

- `--goal <objective>` creates a goal and sends the objective as the turn prompt.
- `--replace-goal <objective>` replaces the active goal and sends the objective as the turn prompt.
- The run remains turn-based at the session layer.
- The CLI process may run multiple turns when goal mode drives the session.
- The process exits when the goal reaches a terminal state or the headless runner receives a terminal turn result.
- Metadata and status JSON shall include a `goal` object when the run is goal-backed.
- Metadata and status JSON shall include `files.responses` for each completed turn.
- Each turn response shall be written as an opaque Markdown file.
- Headless mode shall not add generated headings or goal-status text to turn response Markdown.
- Goal status shall be available in `goal`, `files.goalStatus`, and the final metadata line.

Goal metadata shape:

```json
{
  "goalId": "goal_123",
  "status": "complete",
  "reason": "Objective achieved.",
  "turnsUsed": 3,
  "tokensUsed": 12000,
  "wallClockMs": 45000
}
```

First-slice goal support shall not add the TUI-only `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, or `/goal next` command forms.

If a program needs those forms, add them as explicit headless subcommands in a later plan.

## Plan Approval Contract

Headless mode shall not auto-approve plan exit by default.

The approval handler shall treat plan-exit approval separately from tool approvals.

Default behavior:

- If the agent requests plan-exit approval, set state to `approval_required`.
- Write the approval details to the status file.
- Emit a metadata result with `state: "approval_required"`.
- Return a cancelled or rejected approval response with feedback that the caller must rerun with `--approve-plan` or `--reject-plan`.

`--approve-plan` behavior:

- Approve plan-exit requests only.
- Do not approve arbitrary tool calls.
- Keep normal headless approval behavior for other approvals.
- Record `approval.decision: "approved"` and `approval.decidedByFlag: "approve-plan"` in the status file and metadata header.
- If no plan-exit approval is requested during the run, continue normally and record a non-fatal `PLAN_FLAG_UNUSED` warning.

`--reject-plan` behavior:

- Reject plan-exit requests only.
- Select the existing `Reject and Exit` plan-review choice.
- Do not reject arbitrary tool calls.
- Record `approval.decision: "rejected"` and `approval.decidedByFlag: "reject-plan"` in the status file and metadata header.
- If no plan-exit approval is requested during the run, continue normally and record a non-fatal `PLAN_FLAG_UNUSED` warning.

`--approve-plan` and `--reject-plan` shall conflict.

If both flags are present, fail during CLI validation before creating or resuming a session.

Approval status shape:

```json
{
  "kind": "plan",
  "toolCallId": "call_123",
  "decision": "required",
  "decidedByFlag": null,
  "message": "Plan approval is required. Rerun with --approve-plan to approve plan exit or --reject-plan to reject and exit."
}
```

The first slice does not need to persist a pending approval across processes.

Unused plan flag warning shape:

```json
{
  "code": "PLAN_FLAG_UNUSED",
  "message": "--approve-plan was set, but no plan approval was requested."
}
```

Warnings shall be written to stderr, the status file, and the final metadata line.

## File Structure

Create:

- `apps/kimi-code/src/cli/headless/commands.ts`
  - Registers the `headless` command group.
  - Parses only headless options.
  - Does not reuse prompt-mode `--output-format`.
- `apps/kimi-code/src/cli/headless/run.ts`
  - Owns the `headless run` flow.
  - Creates or resumes sessions through `KimiHarness`.
  - Runs prompt-backed or goal-backed headless execution.
  - Writes Markdown to stdout only for default non-goal runs.
  - Handles `--goal` and `--replace-goal` through the existing goal helpers.
- `apps/kimi-code/src/cli/headless/status-file.ts`
  - Owns status file types.
  - Owns status file preflight.
  - Owns atomic status writes.
  - Owns status file reads for `headless status`.
- `apps/kimi-code/src/cli/headless/output.ts`
  - Owns metadata header formatting.
  - Ensures assistant Markdown is never embedded in the metadata JSON.
- `apps/kimi-code/src/cli/headless/output-files.ts`
  - Resolves the output directory.
  - Owns atomic response file writes.
  - Owns goal status file writes.
- `apps/kimi-code/src/cli/headless/control.ts`
  - Owns control file request and applied-result types.
  - Owns atomic control request writes for helper commands.
  - Owns control request polling for the running process.
- `apps/kimi-code/src/cli/headless/approval.ts`
  - Owns headless approval behavior.
  - Separates plan-exit approval from other approvals.
- `apps/kimi-code/test/cli/headless.test.ts`
  - Covers command parsing, help text, status command behavior, cwd handling, approval, and output.

Create:

- `packages/node-sdk/src/session-lock.ts`
  - Owns session lock acquire and release.
- `packages/node-sdk/test/session-lock.test.ts`
  - Covers lock acquisition, busy lock, stale lock, and release.

Modify:

- `apps/kimi-code/src/cli/commands.ts`
  - Register the `headless` command group.
- `apps/kimi-code/src/main.ts`
  - Route the headless command.
- `apps/kimi-code/test/cli/main.test.ts`
  - Cover routing to headless mode.
- `apps/kimi-code/test/cli/options.test.ts`
  - Keep existing `-p` assertions unchanged.
  - Add regression assertions that `--output-format` remains prompt-mode only.
- `apps/kimi-code/test/cli/run-prompt.test.ts`
  - Run existing prompt-mode tests as regression coverage.
- `packages/node-sdk/src/index.ts`
  - Export the session lock helper.

Do not modify:

- `apps/kimi-code/src/cli/run-prompt.ts`
- `PromptOutputFormat`
- prompt-mode `CLIOptions`

If implementation later needs shared code from `run-prompt.ts`, extract it in a separate reviewed patch with prompt-mode regression tests.

## Task 1: Register the Headless Command

**Files:**

- Create: `apps/kimi-code/src/cli/headless/commands.ts`
- Modify: `apps/kimi-code/src/cli/commands.ts`
- Modify: `apps/kimi-code/src/main.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`
- Test: `apps/kimi-code/test/cli/main.test.ts`
- Test: `apps/kimi-code/test/cli/options.test.ts`

- [ ] **Step 1: Write command parsing tests**

Add tests that parse:

```ts
expect(parseHeadless(['headless', 'run', '--prompt', 'inspect'])).toMatchObject({
  prompt: 'inspect',
  cwd: undefined,
  metadataOnly: false,
});

expect(parseHeadless(['headless', 'run', '--cwd', '/repo', '--prompt', 'inspect'])).toMatchObject({
  prompt: 'inspect',
  cwd: '/repo',
});

expect(parseHeadless(['headless', 'run', '--prompt', 'inspect', '--status-file', '/tmp/kimi.json'])).toMatchObject({
  prompt: 'inspect',
  statusFile: '/tmp/kimi.json',
});

expect(parseHeadless(['headless', 'run', '--prompt', 'inspect', '--output-dir', '/tmp/kimi-run'])).toMatchObject({
  prompt: 'inspect',
  outputDir: '/tmp/kimi-run',
});

expect(parseHeadless(['headless', '--goal', 'raise coverage to 99.5%'])).toMatchObject({
  goal: 'raise coverage to 99.5%',
});

expect(parseHeadless(['headless', 'run', '--goal', 'raise coverage to 99.5%'])).toMatchObject({
  goal: 'raise coverage to 99.5%',
});

expect(parseHeadless(['headless', 'run', '--replace-goal', 'raise coverage to 99.5%'])).toMatchObject({
  replaceGoal: 'raise coverage to 99.5%',
});

expect(parseHeadless(['headless', 'run', '--prompt', 'inspect', '--metadata-only'])).toMatchObject({
  metadataOnly: true,
});

expect(parseHeadless(['headless', 'run', '--prompt', 'inspect', '--approve-plan'])).toMatchObject({
  approvePlan: true,
});

expect(parseHeadless(['headless', 'run', '--prompt', 'inspect', '--reject-plan'])).toMatchObject({
  rejectPlan: true,
});

expect(parseHeadless(['headless', 'goal', 'pause', '--file', '/tmp/kimi-run/status.json'])).toMatchObject({
  action: 'pause_goal',
  statusFile: '/tmp/kimi-run/status.json',
  wait: false,
});

expect(parseHeadless(['headless', 'goal', 'cancel', '--file', '/tmp/kimi-run/status.json', '--wait'])).toMatchObject({
  action: 'cancel_goal',
  statusFile: '/tmp/kimi-run/status.json',
  wait: true,
});

expect(parseHeadless(['headless', 'goal', 'interrupt', '--file', '/tmp/kimi-run/status.json'])).toMatchObject({
  action: 'interrupt',
  statusFile: '/tmp/kimi-run/status.json',
});
```

Add a regression test that `kimi -p "inspect" --output-format=stream-json` still parses through the existing prompt-mode path.

Add a rejection test that `kimi headless run --prompt inspect --output-format=stream-json` fails with a headless-specific message.

Add a rejection test that `kimi headless run --prompt inspect --approve-plan --reject-plan` fails before the run starts.

Add a rejection test that `kimi headless run --prompt inspect --goal "raise coverage"` fails before the run starts.

Add a rejection test that `kimi headless run --goal "raise coverage" --replace-goal "raise coverage"` fails before the run starts.

Add a rejection test that `kimi headless run` fails because it has no input source.

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts apps/kimi-code/test/cli/options.test.ts apps/kimi-code/test/cli/main.test.ts
```

Expected: fail because the headless command group does not exist.

- [ ] **Step 3: Add headless option types**

Create a headless-only type:

```ts
export interface HeadlessRunOptions {
  readonly prompt?: string;
  readonly goal?: string;
  readonly replaceGoal?: string;
  readonly cwd?: string;
  readonly session?: string;
  readonly continue: boolean;
  readonly model?: string;
  readonly statusFile?: string;
  readonly outputDir?: string;
  readonly metadataOnly: boolean;
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly skillsDirs: readonly string[];
}
```

Do not add these fields to prompt-mode `CLIOptions`.

- [ ] **Step 4: Register commands**

Register:

```ts
program
  .command('headless')
  .description('Run and inspect non-interactive Kimi Code turns.');
```

Register subcommands:

- `headless run`
- `headless status`
- `headless goal pause`
- `headless goal cancel`
- `headless goal interrupt`

Register `headless --goal <objective>` as a shortcut that calls the `headless run` handler with `goal` set.

Wire `headless run` to a new handler type.

Wire `headless status` to a new handler type.

- [ ] **Step 5: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts apps/kimi-code/test/cli/options.test.ts apps/kimi-code/test/cli/main.test.ts
```

Expected: pass.

## Task 2: Add Status File Helpers

**Files:**

- Create: `apps/kimi-code/src/cli/headless/status-file.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write status file tests**

Cover:

- atomic write and read
- overwrite an existing status file
- overwrite an existing temp file
- fail when the parent directory does not exist
- fail when the path parent is not writable
- include `runId`
- include summary counters
- include goal status when the run is goal-backed
- include non-fatal warnings
- include response and goal-status file lists

Use this test shape:

```ts
const status: HeadlessRunStatus = {
  schemaVersion: 1,
  runId: 'run_test',
  pid: 123,
  sessionId: 'ses_test',
  turnId: 1,
  state: 'running',
  workDir: '/repo',
  model: 'kimi-code/k2.5',
  startedAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:01.000Z',
  elapsedMs: 1000,
  lastEvent: 'turn.started',
  activeTool: null,
  summary: {
    turnStepCount: 1,
    toolCallCount: 0,
    completedToolCallCount: 0,
    failedToolCallCount: 0,
    assistantCharCount: 0,
    thinkingCharCount: 0,
  },
  approval: null,
  goal: null,
  warnings: [],
  files: {
    outputDir: null,
    responses: [],
    finalResponse: null,
    goalStatus: null,
  },
  control: null,
  error: null,
  resumeCommand: 'kimi -r ses_test',
};

await writeHeadlessRunStatus(filePath, status);
await expect(readHeadlessRunStatus(filePath)).resolves.toEqual(status);
```

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement the helper**

Create these exports:

```ts
export type HeadlessRunState =
  | 'starting'
  | 'running'
  | 'approval_required'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface HeadlessRunSummary {
  readonly turnStepCount: number;
  readonly toolCallCount: number;
  readonly completedToolCallCount: number;
  readonly failedToolCallCount: number;
  readonly assistantCharCount: number;
  readonly thinkingCharCount: number;
}

export interface HeadlessActiveToolStatus {
  readonly toolCallId: string;
  readonly name: string;
  readonly description?: string;
}

export interface HeadlessApprovalStatus {
  readonly kind: 'plan';
  readonly toolCallId?: string;
  readonly decision: 'required' | 'approved' | 'rejected';
  readonly decidedByFlag: 'approve-plan' | 'reject-plan' | null;
  readonly message: string;
}

export interface HeadlessGoalStatus {
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

export interface HeadlessWarning {
  readonly code: string;
  readonly message: string;
}

export type HeadlessOutputFileState = 'writing' | 'completed' | 'failed';

export interface HeadlessResponseFile {
  readonly turnIndex: number;
  readonly turnId: number | null;
  readonly path: string;
  readonly state: HeadlessOutputFileState;
  readonly bytes: number | null;
  readonly updatedAt: string;
}

export interface HeadlessSidecarFile {
  readonly path: string;
  readonly state: HeadlessOutputFileState;
  readonly bytes: number | null;
  readonly updatedAt: string;
}

export interface HeadlessRunFiles {
  readonly outputDir: string | null;
  readonly responses: readonly HeadlessResponseFile[];
  readonly finalResponse: HeadlessResponseFile | null;
  readonly goalStatus: HeadlessSidecarFile | null;
}

export type HeadlessControlAction = 'pause_goal' | 'cancel_goal' | 'interrupt';

export interface HeadlessControlRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly commandId: string;
  readonly action: HeadlessControlAction;
  readonly requestedAt: string;
}

export interface HeadlessAppliedControlRequest {
  readonly commandId: string;
  readonly action: HeadlessControlAction;
  readonly appliedAt: string;
  readonly result: 'applied' | 'failed';
  readonly error?: { readonly message: string };
}

export interface HeadlessRunControl {
  readonly path: string;
  readonly supportedActions: readonly HeadlessControlAction[];
  readonly lastRequest: HeadlessControlRequest | null;
  readonly lastApplied: HeadlessAppliedControlRequest | null;
}

export interface HeadlessRunStatus {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly sessionId: string | null;
  readonly turnId: number | null;
  readonly state: HeadlessRunState;
  readonly workDir: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly lastEvent: string | null;
  readonly activeTool: HeadlessActiveToolStatus | null;
  readonly summary: HeadlessRunSummary;
  readonly approval: HeadlessApprovalStatus | null;
  readonly goal: HeadlessGoalStatus | null;
  readonly warnings: readonly HeadlessWarning[];
  readonly files: HeadlessRunFiles;
  readonly control: HeadlessRunControl | null;
  readonly error: { readonly message: string } | null;
  readonly resumeCommand: string | null;
}
```

Implement:

```ts
export async function preflightHeadlessStatusFile(filePath: string): Promise<void>;

export async function writeHeadlessRunStatus(
  filePath: string,
  status: HeadlessRunStatus,
): Promise<void>;

export async function readHeadlessRunStatus(filePath: string): Promise<HeadlessRunStatus>;
```

- [ ] **Step 4: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 3: Add Session Locking

**Files:**

- Create: `packages/node-sdk/src/session-lock.ts`
- Modify: `packages/node-sdk/src/index.ts`
- Test: `packages/node-sdk/test/session-lock.test.ts`

- [ ] **Step 1: Write lock tests**

Cover:

- acquire creates `<sessionDir>/run.lock`
- second acquire fails with `SESSION_LOCKED`
- release removes the lock
- stale lock with dead pid is removed
- release does not remove another run's lock

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run packages/node-sdk/test/session-lock.test.ts
```

Expected: fail because the lock helper does not exist.

- [ ] **Step 3: Implement the lock helper**

Expose:

```ts
export interface SessionRunLock {
  readonly sessionDir: string;
  readonly runId: string;
  release(): Promise<void>;
}

export interface AcquireSessionRunLockInput {
  readonly sessionDir: string;
  readonly runId: string;
  readonly pid: number;
  readonly command: string;
}

export async function acquireSessionRunLock(
  input: AcquireSessionRunLockInput,
): Promise<SessionRunLock>;
```

Use `fs.open(lockPath, 'wx')` for acquisition.

Use `process.kill(pid, 0)` to detect a live pid where supported.

If live-pid detection is unavailable, treat the lock as live.

- [ ] **Step 4: Run the focused tests**

Run:

```sh
pnpm vitest run packages/node-sdk/test/session-lock.test.ts
```

Expected: pass.

## Task 4: Add Headless Output and File Helpers

**Files:**

- Create: `apps/kimi-code/src/cli/headless/output.ts`
- Create: `apps/kimi-code/src/cli/headless/output-files.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write output tests**

Assert `formatHeadlessMetadataHeader` returns one JSON line and a blank line when `responseOmitted` is false.

Assert the JSON line does not contain the assistant Markdown response.

Assert `formatHeadlessMetadataHeader` returns one JSON line and no trailing blank line when `responseOmitted` is true.

Assert `formatHeadlessMetadataHeader` supports `responseFormat: 'files'`.

Assert `resolveHeadlessOutputDir` uses:

- explicit `--output-dir`
- `<status-file>.d` when only `--status-file` is present
- a run-specific OS temp directory when both options are absent

Assert `writeHeadlessResponseFile` writes Markdown atomically and returns a completed file record.

Assert `writeHeadlessGoalStatusFile` writes JSON atomically and returns a completed file record.

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail because output helpers do not exist.

- [ ] **Step 3: Implement output helpers**

Create:

```ts
export interface HeadlessMetadataHeader {
  readonly type: 'headless.result';
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly turnId: number | null;
  readonly state: HeadlessRunState;
  readonly responseFormat: 'markdown' | 'files' | 'omitted';
  readonly responseOmitted: boolean;
  readonly resumeCommand: string | null;
  readonly summary: HeadlessRunSummary;
  readonly approval: HeadlessApprovalStatus | null;
  readonly goal: HeadlessGoalStatus | null;
  readonly warnings: readonly HeadlessWarning[];
  readonly files: HeadlessRunFiles;
  readonly error?: { readonly message: string };
}

export function formatHeadlessMetadataHeader(header: HeadlessMetadataHeader): string {
  return header.responseOmitted
    ? `${JSON.stringify(header)}\n`
    : `${JSON.stringify(header)}\n\n`;
}
```

Create output file helpers:

```ts
export interface ResolveHeadlessOutputDirInput {
  readonly explicitOutputDir?: string;
  readonly statusFile?: string;
  readonly runId: string;
}

export function resolveHeadlessOutputDir(input: ResolveHeadlessOutputDirInput): string;

export async function preflightHeadlessOutputDir(outputDir: string): Promise<void>;

export async function writeHeadlessResponseFile(input: {
  readonly outputDir: string;
  readonly turnIndex: number;
  readonly turnId: number | null;
  readonly markdown: string;
  readonly updatedAt: string;
}): Promise<HeadlessResponseFile>;

export async function writeHeadlessGoalStatusFile(input: {
  readonly outputDir: string;
  readonly goal: HeadlessGoalStatus;
  readonly updatedAt: string;
}): Promise<HeadlessSidecarFile>;
```

- [ ] **Step 4: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 5: Add Headless Goal Control Helpers

**Files:**

- Create: `apps/kimi-code/src/cli/headless/control.ts`
- Modify: `apps/kimi-code/src/cli/headless/commands.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write control helper tests**

Cover:

- `writeHeadlessControlRequest` writes a control file atomically.
- `readHeadlessControlRequest` reads the latest request.
- `pause` helper command writes `action: "pause_goal"`.
- `cancel` helper command writes `action: "cancel_goal"`.
- `interrupt` helper command writes `action: "interrupt"`.
- helper commands read `control.path` from the status file.
- helper commands fail when the status file has no control path.
- `--wait` polls until `control.lastApplied.commandId` matches.

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail because control helpers do not exist.

- [ ] **Step 3: Implement control helpers**

Create:

```ts
export async function writeHeadlessControlRequest(
  controlPath: string,
  request: HeadlessControlRequest,
): Promise<void>;

export async function readHeadlessControlRequest(
  controlPath: string,
): Promise<HeadlessControlRequest | null>;

export async function waitForHeadlessControlApplied(input: {
  readonly statusFile: string;
  readonly commandId: string;
  readonly timeoutMs: number;
}): Promise<HeadlessAppliedControlRequest | null>;
```

Use atomic replace for control request writes.

Generate a new `commandId` in each helper command.

- [ ] **Step 4: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 6: Add Headless Approval Handling

**Files:**

- Create: `apps/kimi-code/src/cli/headless/approval.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write approval tests**

Cover:

- plan-exit approval without `--approve-plan` returns rejected
- plan-exit approval sets `approval_required`
- plan-exit approval with `--approve-plan` returns approved
- plan-exit approval with `--reject-plan` selects `Reject and Exit`
- `--approve-plan` and `--reject-plan` conflict during option validation
- `--approve-plan` does not approve unrelated tools
- `--reject-plan` does not reject unrelated tools
- unused `--approve-plan` records `PLAN_FLAG_UNUSED` after a run with no plan approval
- unused `--reject-plan` records `PLAN_FLAG_UNUSED` after a run with no plan approval

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail because approval helpers do not exist.

- [ ] **Step 3: Implement approval helpers**

Create:

```ts
export interface HeadlessApprovalOptions {
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly onPlanApprovalRequired: (approval: HeadlessApprovalStatus) => void;
}

export function getUnusedPlanFlagWarning(options: {
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly planApprovalSeen: boolean;
}): HeadlessWarning | null;

export function createHeadlessApprovalHandler(
  options: HeadlessApprovalOptions,
): ApprovalHandler;
```

Detect plan-exit approval from the approval request action or display data.

Return approved only when `approvePlan` is true and the approval is for plan exit.

Return rejected with the existing `Reject and Exit` choice only when `rejectPlan` is true and the approval is for plan exit.

Return rejected or cancelled for plan exit when both flags are false.

Keep the existing headless approval behavior for non-plan approvals.

After the run completes, call `getUnusedPlanFlagWarning`.

If it returns a warning, append it to stderr, status JSON, and final metadata.

- [ ] **Step 4: Run the focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 7: Implement `headless run`

**Files:**

- Create: `apps/kimi-code/src/cli/headless/run.ts`
- Modify: `apps/kimi-code/src/cli/headless/commands.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`
- Test: `packages/node-sdk/test/session-lock.test.ts`

- [ ] **Step 1: Write run-flow tests**

Use a fake harness or the existing CLI fake pattern.

Cover:

- new session uses `--cwd`
- new session defaults to `process.cwd()`
- `--continue` filters sessions by resolved cwd
- `--session` with mismatched `--cwd` fails before resume
- status preflight runs before session creation
- output directory preflight runs before prompt dispatch when files are needed
- existing session lock fails before prompt
- lock releases after completed turn
- default output prints JSON metadata followed by Markdown
- `--metadata-only` prints JSON metadata without Markdown
- `--output-dir` writes non-goal response Markdown to a file and lists it in metadata
- `--goal <objective>` creates a goal and sends the objective as the prompt
- `--replace-goal <objective>` replaces the goal and sends the objective as the prompt
- goal-backed metadata includes `goal.status`
- goal-backed stdout contains metadata only
- goal-backed output writes one Markdown file per completed turn
- goal-backed status JSON lists every completed turn file
- goal-backed output writes `goal-status.json`
- goal-backed status JSON includes `control.path`
- `pause_goal` lets the current turn finish and pauses before the next goal turn
- `pause_goal` does not call `session.cancel()`
- `cancel_goal` lets the current turn finish and cancels before the next goal turn
- `cancel_goal` does not call `session.cancel()`
- `interrupt` calls `session.cancel()` and exits without waiting for the turn to finish
- `interrupt` leaves the goal paused when possible
- response files contain only assistant Markdown, with no generated status wrapper
- unused `--approve-plan` and `--reject-plan` flags produce non-fatal warnings
- status summary counters update after turn, tool, assistant, and thinking events
- prompt-mode tests still pass without changes

- [ ] **Step 2: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts packages/node-sdk/test/session-lock.test.ts apps/kimi-code/test/cli/run-prompt.test.ts
```

Expected: fail because `headless run` is not implemented.

- [ ] **Step 3: Implement session resolution**

Implement this order:

1. Resolve cwd.
2. Preflight status file if present.
3. Create a run id.
4. Resolve and preflight output directory when `--output-dir` is present or goal mode is active.
5. Create the harness.
6. Resolve the session:
   - `--session`: list and validate target.
   - `--continue`: list latest for cwd.
   - neither: create a new session.
7. Acquire session lock.
8. Resolve `--goal` or `--replace-goal` input when present.
9. Create the control file path when goal mode is active.
10. Install approval and question handlers.
11. Start the prompt or goal-backed prompt.
12. Listen to events until `turn.ended`, goal terminal state, or `interrupt`.
13. Poll the control file while the run is active.
14. For `pause_goal`, let the active turn finish, then pause before the next goal turn.
15. For `cancel_goal`, let the active turn finish, then cancel before the next goal turn.
16. For `interrupt`, pause the goal when possible and cancel the active turn immediately.
17. Write each completed turn response file when file output is active.
18. Write `goal-status.json` when goal mode is active.
19. Record unused plan flag warnings if needed.
20. Release lock and close harness.

- [ ] **Step 4: Implement event summary updates**

Increment:

- `turnStepCount` on `turn.step.started`
- `toolCallCount` on `tool.call.started`
- `completedToolCallCount` on non-error `tool.result`
- `failedToolCallCount` on error `tool.result`
- `assistantCharCount` by assistant delta length
- `thinkingCharCount` by thinking delta length

Update `activeTool` on `tool.call.started`.

Clear `activeTool` when the matching tool result arrives.

- [ ] **Step 5: Implement stdout and stderr behavior**

Default stdout:

```text
{"type":"headless.result",...}

<verbatim assistant Markdown>
```

`--metadata-only` stdout:

```text
{"type":"headless.result",...}
```

Goal-backed stdout:

```text
{"type":"headless.result","responseFormat":"files",...}
```

Do not print goal-backed Markdown to stdout.

- [ ] **Step 6: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts packages/node-sdk/test/session-lock.test.ts apps/kimi-code/test/cli/run-prompt.test.ts
```

Expected: pass.

## Task 8: Add `headless status`

**Files:**

- Modify: `apps/kimi-code/src/cli/headless/commands.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write status command tests**

Assert:

```sh
kimi headless status --file /tmp/kimi-run.json
```

prints a compact human summary:

```text
running - session ses_123 - turn 7 - tools 2/3 - updated 2026-06-05T00:00:05.000Z
```

Assert:

```sh
kimi headless status --file /tmp/kimi-run.json --json
```

prints the raw JSON.

Assert `approval_required` output includes:

```text
approval required - plan - rerun with --approve-plan or --reject-plan
```

Assert goal-backed output includes the goal status when present:

```text
goal complete - turns 3 - tokens 12000
```

Assert file-backed output includes the output directory and completed response count:

```text
files 2 - output /tmp/kimi-run
```

Assert pending control output includes:

```text
control pending - pause_goal - command cmd_001
```

- [ ] **Step 2: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail because `headless status` is not implemented.

- [ ] **Step 3: Implement status command output**

Human output shall include:

- state
- session id when present
- turn id when present
- completed and total tool calls
- active tool when present
- approval state when present
- goal state when present
- control pending or applied state when present
- completed response file count when present
- output directory when present
- updated timestamp

- [ ] **Step 4: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 9: Improve Help Text for Agents

**Files:**

- Modify: `apps/kimi-code/src/cli/headless/commands.ts`
- Test: `apps/kimi-code/test/cli/headless.test.ts`

- [ ] **Step 1: Write help tests**

Assert the help includes:

- "Run one turn without the TUI."
- "The process exits when the turn ends."
- "Default output starts with one JSON metadata line, then Markdown."
- `--cwd <dir>`
- `--status-file <path>`
- `--output-dir <dir>`
- `--metadata-only`
- `--approve-plan`
- `--reject-plan`
- `--goal <objective>`
- `--replace-goal <objective>`
- `headless goal pause --file <path>`
- `headless goal cancel --file <path>`
- `headless goal interrupt --file <path>`
- A `headless status` example
- No `--output-format`

- [ ] **Step 2: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: fail until help text is added.

- [ ] **Step 3: Add help examples**

Use Commander `.addHelpText('after', ...)`.

Keep examples short and copy-pasteable.

- [ ] **Step 4: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts
```

Expected: pass.

## Task 10: Verify and Prepare Release Notes

**Files:**

- Modify: `docs/en/reference/kimi-command.md`
- Modify: `docs/zh/reference/kimi-command.md`
- Create: `.changeset/headless-mode.md`

- [ ] **Step 1: Run focused tests**

Run:

```sh
pnpm vitest run apps/kimi-code/test/cli/headless.test.ts apps/kimi-code/test/cli/main.test.ts apps/kimi-code/test/cli/options.test.ts apps/kimi-code/test/cli/run-prompt.test.ts packages/node-sdk/test/session-lock.test.ts
```

Expected: pass.

- [ ] **Step 2: Run app and SDK typechecks**

Run:

```sh
pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck
pnpm --filter @moonshot-ai/kimi-code run typecheck
```

Expected: pass.

- [ ] **Step 3: Update command reference docs**

Document:

- `kimi headless run`
- `kimi headless status`
- `--cwd`
- `--status-file`
- `--output-dir`
- `--metadata-only`
- `--approve-plan`
- `--reject-plan`
- `kimi headless --goal <objective>`
- `kimi headless run --goal <objective>`
- `kimi headless run --replace-goal <objective>`
- `kimi headless goal pause --file <path>`
- `kimi headless goal cancel --file <path>`
- `kimi headless goal interrupt --file <path>`

State that `kimi -p` remains the existing prompt shortcut.

Keep English and Chinese docs in sync.

- [ ] **Step 4: Generate a changeset**

Use the `gen-changesets` skill.

This feature changes user-facing CLI behavior, so the expected package is `@moonshot-ai/kimi-code`.

If the session lock helper is exported from the SDK, include `@moonshot-ai/kimi-code-sdk`.

Use a `minor` bump unless reviewers identify a breaking change.

## Risks

- Accidental prompt-mode changes would break scripts. Keep `-p` untouched and run prompt-mode regression tests.
- Lock files can survive crashes. Detect stale pids and fail clearly when stale detection is not possible.
- Status file writes can become noisy. Write on state changes and important tool transitions only.
- Metadata can become hard to read if it embeds responses. Keep responses out of JSON and store goal-mode turn output in files.
- Plan approval can be ambiguous. Only `--approve-plan` approves plan exit, and only `--reject-plan` rejects and exits plan mode.
- Plan flags can be stale. Treat unused plan flags as warnings, not fatal errors.
- Goal handling can drift from TUI behavior. Reuse the existing headless goal helpers and exit-code mapping for create and replace.
- Response Markdown can collide with generated Markdown structure. Do not inject headings or status blocks into response files.
- Goal pause semantics can drift from the TUI. `pause_goal` shall be graceful and shall not interrupt the active turn.

## Definition of Done

- `kimi headless --help` teaches an agent how to run and inspect one turn.
- `kimi headless run --prompt "..."` runs one turn without the TUI.
- `kimi -p` behavior and output stay unchanged.
- `--cwd` controls the session workspace.
- session locks prevent concurrent local runs for the same session.
- `--status-file` writes valid JSON during the turn and at exit.
- status JSON includes run id, active tool, counters, elapsed time, approval state, goal state, warnings, file lists, and errors.
- `headless status --file <path>` reads the status file.
- default stdout starts with JSON metadata and then prints the verbatim assistant Markdown response.
- `--output-dir` writes response files and lists them in metadata and status JSON.
- `--metadata-only` omits the Markdown response body.
- `--approve-plan` approves only plan-exit requests.
- `--reject-plan` rejects only plan-exit requests by selecting `Reject and Exit`.
- unused `--approve-plan` and `--reject-plan` record non-fatal warnings and do not stop the run.
- `kimi headless --goal <objective>` works as a shortcut for a goal-backed run.
- `--goal <objective>` and `--replace-goal <objective>` work in `headless run`.
- goal-backed runs write each turn response to a separate Markdown file.
- goal-backed runs list response files and `goal-status.json` in status JSON.
- goal-backed stdout contains metadata only and does not print response Markdown.
- `headless goal pause --file <path>` requests a graceful pause after the current turn.
- `headless goal cancel --file <path>` requests graceful cancellation after the current turn.
- `headless goal interrupt --file <path>` interrupts the active turn immediately and leaves the goal paused when possible.
- Focused tests and typechecks pass.
