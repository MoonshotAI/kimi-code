# Kimi Agent Protocol (KAP)

The local server started by `kimi web` (as well as the server embedded in the Kimi Code desktop app) exposes the **Kimi Agent Protocol (KAP)**: a local agent control protocol over HTTP REST (`/api/v1`) and WebSocket (`/api/v1/ws`) (`0.x Beta`). KAP is designed first and foremost so **another live AI agent can interactively drive Kimi Code at runtime over plain HTTP** — supervising progress, steering mid-turn, answering approvals and questions, resuming existing sessions, and triaging session history (as opposed to black-box batch runs with `kimi -p`) — while remaining lightweight for chat bots and custom workbenches.

The full specification is published at [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md); every running server also serves its version-matched built-in copy at `GET /api/v1/kap.md` alongside live schemas at `GET /openapi.json` and `GET /asyncapi.json`.

## What KAP provides

- **Pure HTTP interactive supervision (zero WebSocket boilerplate)**: A supervising agent can create or locate sessions, submit prompts (`/prompts`), block until the next stopping point (`POST /sessions/{id}:wait`, returning immediately with session state and pending prompts/approvals whenever the turn pauses or finishes), inspect and answer tool approvals or questions (`/interactions`), peek at live in-progress turns (`/turns`), and steer mid-turn (`/steer`) using ordinary HTTP calls.
- **Session handoff and batch organization**: Search and inspect existing Desktop or CLI sessions across workspaces, fork (`:fork`) before trying risky changes, rename or reconfigure sessions (`/profile`), and batch-archive finished work (`/sessions:archive`).
- **Live event and task streaming (for bots and custom UIs)**: Chat bots and custom workbenches that render streaming tokens can open a single `/api/v1/ws` WebSocket connection to receive structured `Turn` / `Item` deltas and UTF-8 byte-offset shell or subagent task output.

## Choosing an integration method

| You want to | Use | What you get |
| --- | --- | --- |
| Let another AI agent interactively supervise Kimi Code at runtime (observe progress, steer mid-turn, handle approvals, resume or organize sessions), or build a chat bot / internal workbench | **KAP** | A long-lived HTTP + WebSocket server (embedded in Desktop or started via [`kimi web`](../reference/kimi-command.md#kimi-web)) with pure-HTTP `:wait` + `/interactions` supervision, live turn streaming, mid-turn `/steer`, and full [sessions](./sessions.md), [skills](../customization/skills.md), [plugins](../customization/plugins.md), and [MCP](../customization/mcp.md) support. |
| Connect Kimi Code to an editor or IDE with native ACP support (such as Zed or JetBrains AI Chat) | **[`kimi acp`](../reference/kimi-acp.md)** | A subprocess speaking the [Agent Client Protocol](https://agentclientprotocol.com/) over `stdio`, bound 1-to-1 to the host IDE with multi-turn sessions, approvals, and reverse-RPC file and terminal delegation (see [Using in IDEs](./ides.md)). |
| Work interactively in a terminal, or delegate **one-shot unattended tasks** in scripts or CI/CD | **[`kimi` / `kimi -p`](../reference/kimi-command.md#non-interactive-execution)** | The terminal TUI for daily interactive work; for single-turn unattended delegation, run `kimi -p "<task>" --output-format stream-json` to stream structured JSONL to stdout and exit automatically without running a server. |

## Drive or integrate with an AI agent

> **When NOT to use KAP**: If you only need to dispatch a one-off task and read the final output (with no mid-turn inspection, steering, or approval handling), run `kimi -p "<task>" --output-format stream-json` directly — no KAP server is needed.

When you want interactive supervision, session handoff, history cleanup, or a custom client, fill in the brackets below and send the prompt to your AI agent:

### Scenario 1: Dispatch a task and supervise end-to-end

```text
Drive my local Kimi Code over the KAP protocol to complete the following task: [specific development or refactoring task]. While it runs, monitor its progress, steer mid-turn if needed, and handle tool approvals and questions on my behalf; protocol specification: https://code.kimi.com/kimi-code/kap.md .
```

### Scenario 2: Pick up and continue an existing session

```text
Use the KAP protocol to find the session about [topic or session ID] in my local Kimi Code, inspect its current progress and blockers, and continue driving it to completion (forking a new branch first if appropriate); protocol specification: https://code.kimi.com/kimi-code/kap.md .
```

### Scenario 3: Audit and organize session history

```text
Use the KAP protocol to organize my local Kimi Code session history: review recent sessions, update vague titles with clear ones via the profile endpoint, archive completed or throwaway test sessions, and summarize the remaining active work; protocol specification: https://code.kimi.com/kimi-code/kap.md .
```

### Scenario 4: Build a chat bot or custom workbench client

```text
I am building [a Lark/Slack bot / an internal developer workbench] and want its underlying agent service to integrate with Kimi Code over the KAP protocol. The complete specification is at https://code.kimi.com/kimi-code/kap.md — please implement the integration following that specification.
```

## Connecting and authenticating

Local callers can obtain a server origin and bearer token in either of two ways (and once connected, fetch `GET /api/v1/kap.md` at any time for the exact specification matching that server binary):

- **Attach to a running Desktop app or `kimi web` instance**: Scan `~/.kimi-code/server/instances/*.json` for a live instance (verify `pid` is alive) and authenticate with the local `0600` token file `~/.kimi-code/server.token` via `Authorization: Bearer <token>` — zero pairing prompts required.
- **Spawn a dedicated subprocess on demand**: Run `kimi web --port 0 --json`. It implies `--no-open`, mints an in-memory random bearer token tied to the subprocess lifetime (without reading or printing `~/.kimi-code/server.token`), and prints a single pure JSON line on `stdout`: `{"origin":"http://127.0.0.1:<port>","ws_url":"ws://127.0.0.1:<port>/api/v1/ws","token":"...","kimi_agent_protocol_version":"0.1.0"}`.

## Quick start (pure HTTP loop)

This dependency-free Node.js script drives Kimi Code **with zero WebSocket code**: it spawns `kimi web --port 0 --json`, creates a session, submits a prompt, loops on `:wait` to handle approvals automatically until the turn settles, and prints the final reply. Save it as `demo.mjs` and run `node demo.mjs`:

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn('kimi', ['web', '--port', '0', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const { value: bootLine } = await createInterface({ input: proc.stdout })[Symbol.asyncIterator]().next();
const { origin, token } = JSON.parse(bootLine);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

try {
  const { data: session } = await fetch(`${origin}/api/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cwd: process.cwd() }),
  }).then((r) => r.json());

  await fetch(`${origin}/api/v1/sessions/${session.id}/prompts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt_id: 'p-1',
      content: [{ type: 'text', text: 'Summarize this directory in one sentence.' }],
    }),
  });

  while (true) {
    const { data: waited } = await fetch(`${origin}/api/v1/sessions/${session.id}:wait`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeout_ms: 15000 }),
    }).then((r) => r.json());

    for (const item of waited.pending_interactions) {
      const body =
        item.kind === 'approval'
          ? { kind: 'approval', decision: 'approved' }
          : { kind: 'question', dismissed: true };
      await fetch(`${origin}/api/v1/sessions/${session.id}/interactions/${item.interaction_id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    if (waited.pending_interactions.length === 0 && waited.session.activity !== 'turn') {
      break;
    }
  }

  const { data: page } = await fetch(
    `${origin}/api/v1/sessions/${session.id}/agents/main/turns?page_size=5`,
    { headers },
  ).then((r) => r.json());
  const lastTurn = page.turns.at(-1);
  for (const item of lastTurn?.items ?? []) {
    if (item.type === 'assistant_message') process.stdout.write(`${item.text}\n`);
  }
} finally {
  proc.kill('SIGTERM');
}
```

For bots and UI clients that render live token deltas or background task streams over WebSocket, see Path B in [`kap.md`](https://code.kimi.com/kimi-code/kap.md).

## Next steps

- [`kap.md` full protocol specification](https://code.kimi.com/kimi-code/kap.md) — pure-HTTP agent supervision loop, WebSocket reduction rules, `meta.capabilities` probing, and endpoint catalog
- [`kimi` command](../reference/kimi-command.md#kimi-web) — CLI flags for `kimi web --json` and `-p` non-interactive mode
- [Using in IDEs](./ides.md) — connect Zed and JetBrains IDEs via `kimi acp`
