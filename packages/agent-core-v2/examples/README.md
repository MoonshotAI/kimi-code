# `agent-core-v2` DI × Scope examples

Runnable examples for the `agent-core-v2` engine. Each `*.example.ts` wires one
**vertical functional slice** and teaches one DI × Scope concept. Read in the
order below, they form a learning path from the container itself up to the
edge-exposure layer — together they touch every registered service in the
package.

## Run

```bash
# every example (separate vitest project with its own config + globalSetup)
pnpm --filter @moonshot-ai/agent-core-v2 example

# one example
pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/file-tools.example.ts
```

Examples run under `vitest.examples.config.ts` (project `agent-core-v2-examples`),
which sets up a shared `KIMI_CODE_HOME` via `_globalSetup.ts`. Each file gets an
isolated module registry, so examples that clear and re-populate the scoped
registry do not leak into those that rely on import-time registrations.

## Two styles, both legitimate

- **`bootstrap` + real services + `console.log`** — boots the production
  composition root and shows real behaviour against real files under
  `KIMI_CODE_HOME`. Best for slices where the on-disk result is the point
  (`persistence`, `wire-record`, `session`, `config`, `oauth`, `scope`,
  `observability`).
- **`createScopedTestHost` + explicit re-registration + stubs** — builds a
  minimal scope tree, registers only the slice's services, and stubs the
  collaborators outside it (`stubPair`). Best for isolating one wiring concept
  with no I/O (`di-container`, `file-tools`, `interaction`, `feature-flags`).

Both styles resolve the subject under test **by interface** through the scope
tree — never `new`.

## Learning path

```text
L0  di-container · scope
 └─ L1  observability · config · feature-flags · persistence · events · host
     └─ L2  wire-record · session · session-index · agent-lifecycle
            · tool-framework · context · turn-loop
         └─ L3  file-tools · shell-web · permission · goals · async
                · model · compaction · extensions · oauth · interaction
                · edge · usage · replay
```

## Roadmap

Status: ✅ exists · ⬜ planned.

### L0 — the framework

| file | status | scope | concept |
|---|---|---|---|
| `di-container` | ✅ | A/S/Ag | toy mechanics: `createDecorator`, `registerScopedService`, three `LifecycleScope` tiers, child→parent injection, eager vs delayed, disposal order |
| `scope` | ✅ | A/S | real services: App singletons vs per-Session instances (`ILogService` shared, `ISessionMetadata` per session) |

### L1 — foundational services

| file | status | scope | concept |
|---|---|---|---|
| `observability` | ✅ | A | `log` + `telemetry`, child logger and context-scoped telemetry |
| `config` | ✅ | A | every `registerSection` owner populating one shared `IConfigService` |
| `feature-flags` | ✅ | A | `flag` real, `config` stubbed; env → config → default resolution |
| `persistence` | ✅ | A | Store → Storage → backend; atomic doc / append-log / blob against real `~/.kimi-code` files |
| `events` | ⬜ | A/Ag | soft coupling via `publish`/`subscribe`/`emit`/`on` edges |
| `host` | ⬜ | A/S | host abstraction, the kaos `IExecContext` boundary |

### L2 — business foundations (patterns)

| file | status | scope | concept |
|---|---|---|---|
| `wire-record` | ✅ | Ag | append-log primitive; `append` + `restore` replay chain |
| `session` | ✅ | A/S | `session-lifecycle` + `session-metadata`; session as a durable, tracked entity |
| `session-index` | ✅ | A | business-specific Store building a query read-model |
| `agent-lifecycle` | ⬜ | S | Agent-scope creation, parent/child |
| `tool-framework` | ⬜ | Ag | registry pattern, runtime state |
| `context` | ⬜ | Ag | event-sourced context, projection |
| `turn-loop` | ⬜ | Ag | turn lifecycle, hooks, step loop |

### L3 — complete features (slices)

| file | status | scope | concept |
|---|---|---|---|
| `file-tools` | ✅ | A/S/Ag | the smallest real 3-tier slice: Agent service injecting Session + App ancestors + an Agent peer; marker-interface service registered `Eager` |
| `shell-web-tools` | ⬜ | Ag | tool implementations (bash / web / ask) |
| `permission` | ⬜ | Ag | chain-of-responsibility, policy registry |
| `goals-plans-todos` | ⬜ | Ag | append-log CRUD domains |
| `async-tasks` | ⬜ | Ag | long-running tasks, child scopes (background / cron / swarm) |
| `model-provider` | ⬜ | A/S/Ag | provider abstraction, the kosong boundary |
| `compaction` | ⬜ | Ag | context-management strategy |
| `extensions` | ⬜ | A/S/Ag | plugin / mcp / skill extension points |
| `oauth` | ✅ | A | device-code login + managed `/models` refresh, config-driven |
| `interaction` | ✅ | S | `interaction` kernel + `approval` / `question` facades through the Session scope |
| `edge-gateway-rpc` | ⬜ | A/Ag | `resource:action`, WS events, edge exposure |
| `usage-replay` | ⬜ | Ag | usage metering, replay, system reminder, external hooks |

## Coverage

The existing examples plus the planned ones cover the ~134 registered services in
`agent-core-v2`. The 29 `unresolved` tokens in the dep-graph are external
boundaries (kaos / kosong / storage / vscode DI) and appear as `stubPair(...)`
seeds, not as real implementations.
