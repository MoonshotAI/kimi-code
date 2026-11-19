# Using in Scripts and CI

`kimi -p` (`--prompt`) runs a single prompt without launching the interactive terminal UI, writes the output to `stdout`, and exits automatically once finished — suited for shell scripts, Git hooks, and CI/CD pipelines.

## Basic usage

### Plain text output (default)

```sh
kimi -p "Summarize the latest commit in three sentences"
```

With the default `text` format:

- **`stdout`**: receives only the Assistant reply body (prefixed with `• ` and wrapped with a two-space indent), ready for file redirection or shell pipes;
- **`stderr`**: receives thinking traces, tool progress, and the trailing resume hint (`To resume this session: kimi -r <session_id>`), keeping redirected `stdout` clean.

### Structured JSONL output (`stream-json`)

When parsing output from scripts or CI jobs, pass `--output-format stream-json` (or set `KIMI_MODEL_OUTPUT_FORMAT=stream-json`):

```sh
kimi -p "List all exported functions in this directory" --output-format stream-json
```

Each line written to `stdout` is a standalone JSON object (JSONL):

```json
{"role":"assistant","content":"","tool_calls":[{"type":"function","id":"call_1","function":{"name":"Grep","arguments":"{\"pattern\":\"export function\"}"}}]}
{"role":"tool","tool_call_id":"call_1","content":"..."}
{"role":"assistant","content":"The directory exports the following functions: ..."}
{"role":"meta","type":"session.resume_hint","session_id":"session_01...","command":"kimi -r session_01...","content":"To resume this session: kimi -r session_01..."}
```

- Assistant replies and tool invocations use `role: "assistant"` (with `tool_calls` when invoking tools);
- Tool execution results use `role: "tool"`;
- Step retry notices and the final session hint use `role: "meta"` (`type: "turn.step.retrying"`, `type: "session.resume_hint"`).

Extract the final assistant text with `jq`:

```sh
kimi -p "Draft a commit message for the staged diff" --output-format stream-json \
  | jq -r 'select(.role == "assistant" and .content != null and (.tool_calls | not)) | .content' \
  | tail -n 1
```

## Common patterns

### Passing diffs and logs

Inline command output or point Kimi Code at files on disk:

```sh
# Review staged changes
kimi -p "Review this staged diff for bugs and edge cases: $(git diff --cached)"

# Diagnose a CI log file
kimi -p "Read /tmp/ci-test.log, identify the root cause, and propose a fix"
```

### Chaining multi-step runs on the same session

Every `-p` run saves its session and emits `session_id` at the end. Pass `-S <session_id>` (or `-c` in the same project directory) to continue sequentially:

```sh
# Step 1: implement changes and capture session_id
RUN=$(kimi -p "Add input validation to src/retry.ts" --output-format stream-json)
SID=$(printf '%s\n' "$RUN" | jq -r 'select(.type == "session.resume_hint") | .session_id')

# Step 2: run tests and fix failures in the same session context
kimi -S "$SID" -p "Run unit tests and fix any failures"
```

### Selecting models, custom agents, and extra directories

```sh
# Override the model for this run
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"

# Start a new session with a custom reviewer agent profile
kimi --agent reviewer -p "Review changes on this branch against main"

# Grant access to an extra directory
kimi --add-dir ../shared-types -p "Align API request/response types"
```

## Permissions and exit codes

- **Permission policy**: `-p` runs unattended without interactive approval prompts — regular file and shell operations run automatically, while `deny` rules in your config still block disallowed actions (no need to pass `--auto` or `--yolo`).
- **Exit codes**:
  - `0`: Completed normally;
  - `1`: Invalid CLI options, missing model credentials, or turn execution error;
  - `4`: The target session (`-S` / `-c`) is currently in use by another process (`stream-json` also writes `{"type":"error",...}` to `stdout`).

## Next steps

- [Using in Other Agents](./other-agents.md) — delegate tasks and hand off sessions from Claude Code, Codex, and Cursor
- [Agents and Subagents](../customization/agents.md#custom-agents) — author custom `--agent` / `--agent-file` profiles
- [`kimi` command reference](../reference/kimi-command.md) — full CLI option reference
