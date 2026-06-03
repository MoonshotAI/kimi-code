# `kimi acp` Subcommand

`kimi acp` switches Kimi Code CLI into **ACP (Agent Client Protocol)** mode: it speaks JSON-RPC on stdio to an ACP client (Zed, JetBrains AI Chat, etc.) so an IDE can drive kimi's sessions, prompts, and tool calls directly.

```sh
kimi acp
```

When launched, the command prints no banner — it immediately waits for an `initialize` request on stdin. Logs go to stderr (and to the diagnostic log under `~/.kimi-code/logs/`), keeping the ACP channel clean.

::: tip Who calls this?
You typically never run `kimi acp` by hand — it's the subprocess entry point an IDE will spawn. For the IDE-side configuration, see [Using in IDEs](../guides/ides.md).
:::

## Capability Matrix

The ACP adapter advertises the following capabilities in its `initialize` response. IDEs can use these to enable or disable UI affordances.

| Capability | Value | Notes |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | Accepts ACP `image` content blocks (base64 + mimeType). |
| `promptCapabilities.audio` | `false` | Audio prompts are not supported. |
| `promptCapabilities.embeddedContext` | `false` | Embedded resource prompts are not advertised; `resource`/`resource_link` are still accepted through the text channel. |
| `mcpCapabilities.http` | `true` | HTTP MCP servers from the IDE are forwarded. |
| `mcpCapabilities.sse` | `false` | SSE MCP servers are dropped (with a warn log). |
| `loadSession` | `true` | `session/load` is supported; history is replayed via `session/update` on resume. |
| `sessionCapabilities.list` | `{}` | `session/list` enumerates the user's sessions. |

## ACP method coverage

The spec splits methods into a **stable** surface and a still-evolving **unstable** surface (the `unstable_*`-prefixed handlers on `@agentclientprotocol/sdk@0.23.0`). The two are tracked separately because they have very different stability guarantees — the stable surface is what any production ACP client will exercise; the unstable surface covers experimental extensions (inline-edit predictions, document buffer sync, provider management, elicitation, etc.).

**Summary: 10/12 stable agent-side methods (83%) + 4/9 stable client reverse-RPCs (44%); on the unstable surface only `session/set_model` is wired (1/19).** Every method needed for a normal agent flow (initialize → auth → new/load/resume → prompt → cancel + file I/O + tool approval) is implemented.

### Stable agent-side — IDE → agent (10 / 12)

| Method | Status | Notes |
| --- | --- | --- |
| `initialize` | yes | Version negotiation; returns `agentInfo: { name: 'Kimi Code CLI', version }`, capability matrix, `authMethods` |
| `authenticate` | yes | Validates `method_id='login'`; missing token → `authRequired (-32000)`, unknown id → `invalidParams (-32602)` |
| `session/new` | yes | Accepts `cwd` / `mcpServers`; returns `configOptions[]` |
| `session/load` | yes | Rehydrates on-disk session and replays history as `session/update` notifications |
| `session/resume` | yes | Lighter-weight sibling of `session/load`; skips history replay (spec G4) |
| `session/prompt` | yes | Accepts `text` / `image` / `resource` / `resource_link` content blocks; streams `agent_message_chunk` |
| `session/cancel` | yes | Interrupts the current turn |
| `session/list` | yes | Enumerates on-disk sessions (advertised via `sessionCapabilities.list = {}`) |
| `session/set_mode` | yes | Compatibility path; funnels into the same dispatcher as `set_config_option({configId:'mode'})` |
| `session/set_config_option` | yes | Unified model / thinking / mode picker dispatch |
| `session/close` | no | |
| `logout` | no | |

### Stable client-side reverse-RPC — agent → IDE (4 / 9)

| Method | Status | Notes |
| --- | --- | --- |
| `session/update` | yes | Streams `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | yes | Tool approvals and question elicitation share this channel |
| `fs/read_text_file` | yes | kaos file reads route to the client (advertised by `fsCapabilities`) |
| `fs/write_text_file` | yes | kaos file writes route to the client |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | no | Terminal reverse-RPC not yet wired; shell commands run locally |

### Unstable surface (1 / 19)

| Method | Status | Notes |
| --- | --- | --- |
| `session/set_model` | yes | Compatibility path; equivalent to `set_config_option({configId:'model'})`. Also accepts the legacy `'<alias>,thinking'` merged form, which is split into a bare-model `setModel` plus an implicit `setThinking('high')` |
| `session/delete` · `session/fork` | no | Session lifecycle extensions |
| `document/didOpen` · `didChange` · `didClose` · `didFocus` · `didSave` | no | Editor buffer sync |
| `nes/start` · `suggest` · `accept` · `reject` · `close` | no | Inline-edit predictions |
| `providers/list` · `set` · `disable` | no | Built-in provider management (use `kimi provider` instead) |
| `elicitation/create` · `elicitation/complete` | no | Currently overlapped by `session/request_permission` |

(`mcp/connect`, `mcp/disconnect`, `mcp/message` are declared in the SDK enum but not yet routed by the SDK dispatcher itself, so they sit outside the coverage denominator.)

Any method not listed above returns `methodNotFound`.

## Session configOptions

Starting in Phase 14, `session/new` and `session/load` no longer return a dedicated `modes` field. Instead, both pickers ride on the ACP spec's generic `configOptions: SessionConfigOption[]` surface. Phase 15 split thinking out of the model id into its own axis, and Phase 16 reshaped that axis from `SessionConfigBoolean` to a 2-entry `select` (`off` / `on`) so Zed renders it — Zed's chip strip currently only knows how to draw `type: 'select'`. The advertisement now ships up to three options:

- `id: 'model'` (`type: 'select'`, `category: 'model'`) — one row per configured model alias. **No more `,thinking` variant rows** — thinking has moved to a separate axis below.
- `id: 'thinking'` (`type: 'select'`, `category: 'thought_level'`, options `[{value:'off'},{value:'on'}]`) — appears **only when the currently-selected model's catalog entry advertises `thinkingSupported`**. Switching to a non-thinking model causes the next `config_option_update` to omit this option entirely; the client should re-render the picker strip accordingly.
- `id: 'mode'` (`type: 'select'`, `category: 'mode'`) — the locked four-mode taxonomy from PLAN D9: `default` / `plan` / `auto` / `yolo`.

Example `configOptions` payload (current model supports thinking):

```json
{
  "configOptions": [
    {
      "type": "select",
      "id": "model",
      "name": "Model",
      "category": "model",
      "currentValue": "kimi-coder",
      "options": [
        { "value": "kimi-coder", "name": "Kimi Coder" },
        { "value": "kimi-v2", "name": "Kimi v2" }
      ]
    },
    {
      "type": "select",
      "id": "thinking",
      "name": "Thinking",
      "category": "thought_level",
      "currentValue": "off",
      "options": [
        { "value": "off", "name": "Thinking Off" },
        { "value": "on", "name": "Thinking On" }
      ]
    },
    {
      "type": "select",
      "id": "mode",
      "name": "Mode",
      "category": "mode",
      "currentValue": "default",
      "options": [
        { "value": "default", "name": "Default", "description": "Manual approvals; tools execute normally." },
        { "value": "plan", "name": "Plan", "description": "Read-only planning; no tool execution." },
        { "value": "auto", "name": "Auto", "description": "Auto-approve safe operations." },
        { "value": "yolo", "name": "YOLO", "description": "Auto-approve everything." }
      ]
    }
  ]
}
```

**Switching:** clients should prefer the generic `session/set_config_option({ sessionId, configId, type, value })` path. For compatibility, `session/set_session_mode` and `session/unstable_set_session_model` still work — the entry points all funnel to the same execution path inside the adapter. Notes on each `configId`:

- `'model'` accepts the bare alias id (e.g. `'kimi-coder'`) or the legacy merged form `'kimi-coder,thinking'` — the latter is split into a bare-model `setModel` plus an implicit thinking-on call so older clients keep working.
- `'thinking'` accepts the strings `'on'` / `'off'` and maps to `Session.setThinking('high')` (`'on'`) or `Session.setThinking('off')` (`'off'`). The granularity of `'low' / 'medium' / 'xhigh' / 'max'` is intentionally hidden behind the binary wire — Phase 16 uses a 2-entry `select` instead of `SessionConfigBoolean` for Zed UI compatibility only.
- `'mode'` accepts one of `'default' / 'plan' / 'auto' / 'yolo'` (PLAN D9).

**Change notifications:** every model, thinking, or mode change pushes `sessionUpdate: 'config_option_update'` with the full `configOptions` snapshot. Phase 12's `current_mode_update` has been retired and is no longer emitted.

## MCP Forwarding

When an ACP client provides `mcpServers` in `session/new` or `session/load`, the adapter converts them as follows:

- `http` → kimi `transport: 'http'` (headers projected to `Record<string, string>`).
- `stdio` → kimi `transport: 'stdio'` (env projected the same way).
- `sse` / `acp` → dropped, with a warn log line, so unsupported transports never silently fall through.

## When to Use `kimi acp`

- **Direct IDE integration**: see [Using in IDEs](../guides/ides.md).
- **Custom ACP client**: connect `@agentclientprotocol/sdk`'s `ClientSideConnection` to `kimi acp`'s stdio. A single client implementation can then drive kimi, Claude Code, or any other ACP agent.
- **Local integration testing**: this repository's `packages/acp-adapter` ships an in-memory pipe end-to-end test that exercises `initialize` → `session/new` → `session/prompt` → `end_turn`, which can serve as a reference implementation.

For normal CLI interactions, keep using `kimi` (without the `acp` subcommand) to launch the TUI.
