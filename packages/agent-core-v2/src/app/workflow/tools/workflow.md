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

## When to use

- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer
- **Complex orchestration** — when a task requires multiple phases of parallel agent work
- **Structured pipelines** — when you need to chain agent outputs through transformation stages
