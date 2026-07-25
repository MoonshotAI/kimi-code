Run multi-phase orchestrated agent workflows.

## Operations

### `run` — start a workflow
Launches a workflow in the background. Returns immediately with a `run_id`; the result is delivered as a notification when the workflow completes.

```
Workflow({ operation: "run", name: "deep-research", args: "How does RAG compare to fine-tuning?" })
```

You can also run an inline script:
```
Workflow({ operation: "run", script: "export const meta = { name: 'quick', description: '...' };\nphase('search');\nconst result = await agent('Search for...');\nreturn result;", args: "..." })
```

### `status` — check progress
```
Workflow({ operation: "status", run_id: "wf_1" })
```

### `wait` — block until done
```
Workflow({ operation: "wait", run_id: "wf_1", timeout_ms: 60000 })
```

### `cancel` — cancel a running workflow
```
Workflow({ operation: "cancel", run_id: "wf_1" })
```

## Built-in workflows

- **deep-research** — Multi-source research with adversarial jury fact-checking. Plans search lines, runs parallel web searches, extracts facts from top sources, cross-checks each fact with 3 jurors (majority reject drops it), and writes a cited report.
- **code-review** — Multi-dimensional code review across security, performance, correctness, and maintainability. Runs parallel reviewers and produces a consolidated severity-ranked report.
- **test-generator** — Automated test generation. Analyzes source code, plans test cases, generates test files with proper mocks, and validates output.
- **refactor-planner** — Refactoring impact analysis and migration planner. Identifies improvement opportunities, assesses risk, and generates a phased plan with rollback steps.
- **bug-triage** — Automated bug triage. Parses error logs and stack traces, reads suspect source files, identifies root causes, and generates fixes with reproduction steps.
- **pr-description** — PR description generator. Analyzes code diffs, extracts semantic intent, and generates a comprehensive PR body with changelog entries and reviewer guidance.
- **architecture-review** — Architecture and dependency analysis. Detects circular dependencies, measures coupling, identifies layer violations, and generates architecture documentation.
- **security-audit** — Security vulnerability audit. Scans for OWASP Top 10, hardcoded secrets, injection points, auth flaws, and produces a prioritized remediation plan.
- **migration-planner** — Migration and upgrade planner. Analyzes dependency versions, identifies breaking changes, maps code changes, and generates a phased migration plan with compatibility shims.

## In-script primitives

Workflow scripts are JavaScript that runs in a sandbox with these injected globals:

- **`agent(prompt, opts?)`** — Spawn a subagent. Returns the agent's result (parsed JSON if `opts.schema` given, else text) or `null` on failure. **Never throws.**
  - `opts.agentType` — subagent profile (default 'coder')
  - `opts.schema` — JSON schema for structured output
  - `opts.label` — display label
  - `opts.phase` — phase tag
  - `opts.timeoutMs` — per-agent timeout

- **`parallel(thunks)`** — Run thunks concurrently. Returns array of results.

- **`pipeline(items, ...stages)`** — Run each item through all stages. No barrier between stages — items flow through independently.

- **`phase(title)`** — Set the current phase (for progress tracking).

- **`log(message)`** — Log a message.

- **`readFile(path)` / `writeFile(path, content)` / `glob(pattern)` / `exists(path)`** — File IO jailed to the workspace root.

- **`args`** — The `args` value passed to `run`.

- **`fetch(url, opts?)`** — Make an HTTP request. Returns `{ ok, status, body }`. `opts` can have `method`, `headers`, `body`. 15s timeout. Never throws — failures return `{ ok: false, status: 0, body: errorMessage }`.

- **`search(query)`** — Web search. Returns an array of `{ title, url, snippet }`. Returns empty array when search is unavailable or fails. Never throws.

- **`exec(command, opts?)`** — Execute a shell command. Returns `{ stdout, stderr, exitCode }`. `opts` can have `timeoutMs` (default 30s) and `cwd` (relative to workspace root). The command runs in the workspace directory. Never throws — non-zero exit codes are returned, not thrown.

## When to use

- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer
- **Code review** — when the user wants a multi-dimensional review of code changes
- **Test generation** — when the user wants to add tests for existing untested code
- **Refactoring** — when the user wants to plan safe, incremental code improvements
- **Bug triage** — when the user reports an error, crash, or test failure
- **PR descriptions** — when the user needs to document code changes for a pull request
- **Architecture review** — when evaluating system design or detecting design decay
- **Security audit** — when auditing code for OWASP Top 10 vulnerabilities
- **Migration planning** — when upgrading dependencies or migrating between frameworks
- **Complex orchestration** — when a task requires multiple phases of parallel agent work
- **Structured pipelines** — when you need to chain agent outputs through transformation stages
