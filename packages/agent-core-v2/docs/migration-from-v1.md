# Migrating from agent-core v1 to v2

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root.

> The v1 package was deleted on main immediately afterwards (#3542). This document records the code facts at the moment of deletion, for consumers that still hold a v1 dependency and need to finish migrating.

## 0. Read this first

This document is for maintainers of consumers that still depend on `@moonshot-ai/agent-core` (v1). After reading it you should know: whether you need to migrate, what each step changes, and what you must not do. It does not compare the two architectures on their merits; where each v1 domain went in v2 is only listed in the cheat sheet in Appendix A.

Migration is complete when your code no longer references `@moonshot-ai/agent-core` anywhere and observable behavior matches the pre-migration behavior (verify with the method in §2.6).

## 1. Current state (at the baseline, verified)

### 1.1 The two packages

| | v1 | v2 |
|---|---|---|
| Package | `packages/agent-core`, `@moonshot-ai/agent-core` 0.15.8 | `packages/agent-core-v2`, `@moonshot-ai/agent-core-v2` 0.4.3 |
| Entry points | root barrel (`src/index.ts`) + one named subpath `./session/store`; `exports` point straight at src, no prebuilt dist | root barrel + arbitrary subpaths (`./src/*`) |
| Shape | `Agent` / `Session` / `KimiCore` classes + an in-process DI service layer (`src/di/`, `src/services/`) | three LifecycleScope tiers (App / Session / Agent, `src/app/scopes.ts`; the workspace granularity is carried by `Program` generations) + the Service / Fiber unit layer + the Feature seam (`src/features/`) |

### 1.2 Who still depends on v1

At the baseline there are exactly two places in the repo:

1. `packages/node-sdk` — the only package declaring the dependency in package.json (`packages/node-sdk/package.json:62`, in the `devDependencies` block). Nineteen source files import from the v1 root entry: protocol types, errors, config read/write, logging, images, replay / agentfile / proxy helpers, and so on — **no deep subpath imports at all**. node-sdk also depends on v2 (same file, :63) and is a complete example of dual-engine coexistence (Appendix B).
2. `apps/vscode/tsdown.config.ts:22-28` — a bundling alias that resolves `@moonshot-ai/agent-core` to the v1 source entry, inlining it (transitively via node-sdk) into the extension bundle. Purely build-time behavior; once v1 is deleted, the extension build fails at bundler resolution.

### 1.3 The runtime switch

`KIMI_CODE_LEGACY_FLAG` (truthy = `1` / `true` / `yes` / `on`) selects between the two harnesses at each CLI entry: v1 `createKimiHarness` (`packages/node-sdk/src/sdk-rpc-client.ts:145`) or v2 `createKimiHarnessV2` (`packages/node-sdk/src/sdk-rpc-client-v2.ts:2732`). Read at `apps/kimi-code/src/cli/experimental-v2.ts:14`. `kimi web` / `kimi acp` ignore the switch and always run v2. The VS Code equivalent is `LEGACY_ENGINE_ENV` (`apps/vscode/src/config/vscode-settings.ts:8`). CI runs a dual-engine matrix (`.github/workflows/ci.yml:88`).

It is a fallback switch, not a long-term shape: new code always takes the v2 path.

### 1.4 Data compatibility

- **Wire records (journal)**: the two engines share the same record vocabulary. v1 `AGENT_WIRE_PROTOCOL_VERSION = '1.4'` (`packages/agent-core/src/agent/records/migration/index.ts:11`), v2 `WIRE_PROTOCOL_VERSION = '1.5'` (`packages/agent-core-v2/src/wire/migration/migration.ts:19`); v2's migration chain is a superset of v1's (one extra step, v1.5). When reading a journal, v2 folds each record through the chain to upgrade it; records written by a newer version are passed through un-migrated (`src/wire/wireService.ts:141-166`).
- **Corruption repair**: when the read path hits a truncated journal, v2 `src/wire/repair.ts` rewrites the valid prefix back to the original file and backs the damaged tail up as `<key>.bak`.
- **One-shot config migrations**: the mechanism is kept under the same name (v1 `config/migrations.ts` → v2 `app/config/migrations.ts`), with completed items marked in `<home>/migrations-effort.json`; re-running is harmless.
- `packages/migration-legacy` is the kimi-cli (Python) → kimi-code user-data migrator and is unrelated to the code migration in this document; but it depends only on v2 and is a finished example of "a consumer fully switched to v2".

## 2. Migration steps

### 2.1 Step 1: Classify your v1 usage

v1 usage falls into three classes with different migration paths — classify first:

- (a) Types and pure functions only (protocol types, config read/write, errors, logging, images, schema validation) → go to 2.2;
- (b) Instantiating the engine (`new KimiCore` / `new Session` / `new Agent`) → go to 2.3;
- (c) Using the RPC protocol and event surface (`CoreAPI` / rpc `Event`) → go to 2.4.

node-sdk has all three, and this document uses it as the reference throughout.

### 2.2 Step 2: Switch the dependency and the import surface

In `package.json`, replace `@moonshot-ai/agent-core` with `@moonshot-ai/agent-core-v2` (you may keep both temporarily, as node-sdk does, then drop v1). v2's `exports` allow arbitrary subpath imports, but prefer the root entry; use a subpath only for symbols the root entry does not export (node-sdk's precedents: `_base/utils/workdir-slug`, `mcpCore/connection-manager`, `app/mcpConfig/configLoader`, `workspace/workspaceFs/fs`, `persistence/interface/appendLogStore`, `mcpCore/config-schema`).

Group-by-group mapping (v1 symbol → v2 counterpart; v2 paths are under `packages/agent-core-v2/src/`):

**Config**

| v1 | v2 | Notes |
|---|---|---|
| `resolveConfigPath` / `resolveKimiHome` | same names (`app/bootstrap/bootstrap.ts:171` / `:163`) | direct counterpart |
| `ensureKimiHome` | same name (`app/bootstrap/bootstrap.ts`) | direct counterpart |
| `loadRuntimeConfigSafe` / `KimiConfig` / `readConfigFile` / `writeConfigFile` / `ensureConfigFile` / `parseConfigString` | **no counterpart** | v2 has no single-document config schema: use `IConfigService` (`app/config/configService.ts`) + per-domain `ConfigSection` registration. When you need the v1 shape, follow node-sdk `src/v2/config-mapper.ts`, which folds the per-domain views back into a `KimiConfig` |
| `SECONDARY_DERIVED_MODEL_ALIAS` | **gone** | no such constant in v2 |
| `HookDefSchema` | `features/externalHooks/configSection.ts` | |
| `McpServerConfigSchema` | `mcpCore/config-schema.ts` | |
| `effectiveModelAlias` and other model resolution | `app/kosongConfig/` | |

**Errors**

| v1 | v2 | Notes |
|---|---|---|
| `KimiError` | `Error2` (`_base/errors/errors.ts:38`) | `isKimiError` → `isError2`. node-sdk's approach: alias internally as `Error2 as V2Error2`, while the public SDK surface keeps the v1 `KimiError` shape |
| `ErrorCodes` | same name (v2 root `errors.ts:73`, aggregated per domain) | error-code strings are mostly unchanged |

**Logging**

| v1 (`logging/`) | v2 (`_base/log/`, exported via the root entry) |
|---|---|
| `getRootLogger()` / `log` | `ILogService`; initialize with `logSeed(resolveLoggingConfig({ homeDir, env }))` as a scope seed, shut down with `drainLogCloses()` (usage: node-sdk `sdk-rpc-client-v2.ts:466,534`) |

**Images**

| v1 (`tools/support/`) | v2 (`agent/media/`) |
|---|---|
| `compressImageForModel` and the other compression helpers | same names (`agent/media/image-compress.ts`, exported from the root entry) |
| `ImageLimits` class | **gone**, replaced by constants and resolver functions: `IMAGE_BYTE_BUDGET` / `MAX_IMAGE_EDGE_PX` / `READ_IMAGE_BYTE_BUDGET` / `resolveMaxImageEdgePx` (exported from the root entry) |
| format policy (MIME gating etc.) | `agent/media/image-format-policy.ts` |

**Miscellaneous**

| v1 | v2 |
|---|---|
| `parseAgentFileText` / `resolveAgentPath` | same names (`workspace/workspaceAgentProfileLoader/internal/`, exported from the root entry) |
| `installGlobalProxyDispatcher` | same name (`_base/utils/proxy.ts:218`) |
| `Emitter` / `Event` (`base/common/event.ts`) | same names (`_base/event.ts`) |
| flag types and the central registry | `registerFlagDefinition` (`app/flag/flagRegistry.ts`) + `IFlagService.enabled(id)` |
| `noopTelemetryClient` / `withTelemetryContext` | `app/telemetry/`: `ITelemetryService` / `noopTelemetryService` plus context types; the free function `withTelemetryContext` has no same-named counterpart — context is passed through the Service |
| `AGENT_WIRE_PROTOCOL_VERSION` | `WIRE_PROTOCOL_VERSION` (`wire/migration/migration.ts:19`) |
| `limitAgentReplayByTurns` / `ReplayBuilder` | only types remain in the engine (`agent/replayBuilder/types.ts`); the implementation moved out — see the note in 2.3 |
| `MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE` | `agent/mcp/tools/auth.ts` |
| `ToolStore` (`tools/store.ts`) | **gone**: tool state is folded into state / replayable keys and per-domain Ops |

### 2.3 Step 3: Switch engine instantiation

The v1 shape (node-sdk `sdk-rpc-client.ts:77-89`):

```ts
const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
this.core = new KimiCore(coreRpc, { homeDir, configPath, ... });
// core.createSession() / core.shutdown()
```

`Session` (`packages/agent-core/src/session/index.ts:230`) and `Agent` (`packages/agent-core/src/agent/index.ts:115`) are created under KimiCore / Session; `resume()` replays the wire records, and `turn.prompt()` drives the conversation.

The v2 shape (template: `packages/kap-server/src/start.ts:196`):

1. `bootstrap(input, extraSeeds?)` (`app/bootstrap/bootstrap.ts:138`) returns the App scope. `input` resolves `KIMI_CODE_HOME`, `config.toml`, and clientIdentity; `extraSeeds` carries seeds such as logging (`logSeed`).
2. Everything afterwards goes through `scope.accessor.get(IXxxService)`: `IConfigService`, `ISessionIndex`, `IWorkspaceInstanceManager`, `IPluginService`, `IEventService`, etc.
3. Each workspace gets one `Program` (`program/program.ts:113`); construction establishes the workspace generation (state / dirs / fs / watch / git / instructions / mcp / skills / agentProfiles). `program.createSessionController()` is the session-lifecycle entry; agents are created inside the session controller.
4. Consumer helper functions (exported from the v2 root): `programForSession` / `resumeSessionById` / `closeSessionById` / `getLiveSessionById` / `followSessionLifecycles` / `ensureMainAgent` / `agentContextOf`.
5. Shutdown path: `drainSessionIndexMirror` / `drainQueryStoreDisposals` / `drainLogCloses` / `IMcpOAuthService.shutdown()`.

For a complete post-migration shape, read node-sdk `sdk-rpc-client-v2.ts` (~2700 lines) — it is the finished product of "same public SDK, internals switched from v1 to v2"; the six mapper files in its `src/v2/` directory are block-by-block examples (Appendix B).

**Note**: node-sdk `src/v2/resume-replay.ts:108-113` currently borrows v1's `Agent` / `AgentRecords` to fold a v2 wire.jsonl into a v1-shaped replay — this usage depends on the v1 package still existing; once v1 is deleted it must be replaced by folding in the consumer (`packages/transcript` provides reducers). Do not carry this pattern into new code.

### 2.4 Step 4: Switch the RPC and event surface

v1's `rpc/` layer moved out of the engine entirely in v2:

| v1 | Where it went in v2 |
|---|---|
| protocol types (`CoreAPI` / rpc `Event` / `SDKAPI`) | `packages/protocol` + `packages/klient` (`global.*` / `session(id).*` / `agent(id).*` facade, zod-validated) |
| server-side implementation (`KimiCore`, `packages/agent-core/src/rpc/core-impl.ts:224`) | `packages/kap-server` (REST + WebSocket; the v1 REST shape is projected through v2 `app/sessionLegacy/`) |
| in-process `createRPC` pair | in-engine events: `IEventBus` (`app/event/eventBus`) + `Event2` (`app/event/event2`) |

If you must keep events in the v1 shape, write a pure mapper following node-sdk `src/v2/event-mapper.ts` (stamping sessionId / agentId); for the session-metadata shape differences (ISO time ↔ epoch millis, `workDir` ↔ `cwd`) follow `src/v2/session-mapper.ts`.

### 2.5 Step 5: Confirm data compatibility

Check each item in 1.4: wire journals upgrade automatically from older versions (newer ones are passed through un-migrated); the one-shot config migration mechanism is unchanged; the `~/.kimi-code/` directory layout is unchanged. If your consumer persisted any v1-private shape (for example replay snapshots), boot v2 once against real data to verify.

### 2.6 Step 6: Verify

1. Types and build: the consumer's build and typecheck pass, and `rg "@moonshot-ai/agent-core"` has zero hits in your package (watch out for false matches from the `agent-core-v2` prefix).
2. Behavior comparison: use `KIMI_CODE_LEGACY_FLAG` to run the same flow on both engines (CI runs exactly this matrix); observable behavior matches on both sides.
3. Data: boot v2 against a real session directory and confirm journal migration, replay rebuild, and config reads are consistent.

## 3. Discipline

1. Do not add any new dependency on v1. v1 is deleted on main (#3542); new v1 references cannot land on main.
2. `KIMI_CODE_LEGACY_FLAG` is a fallback switch, not a long-term shape; new code always lands on the v2 path.
3. Do not add compatibility shims for v1 shapes inside the v2 engine. Shims live only in consumers (follow node-sdk `src/v2/*.ts`).
4. No new deep-subpath references on the v1 side; on the v2 side prefer the root entry, with subpaths limited to symbols the root entry does not export.
5. Do not copy v1 implementations into v2. Appendix A shows where each domain already lives in v2; entries marked "gone" (e.g. `ToolStore`, the `ImageLimits` class, `SECONDARY_DERIVED_MODEL_ALIAS`) disappeared deliberately — rewrite the consumer per the replacements in 2.2.

## Appendix A: domain-mapping cheat sheet

Paths in the "v2 destination" column are under `packages/agent-core-v2/src/`; "→ external package" means the capability left the engine entirely.

### A.1 v1 `src/` top level

| v1 (`packages/agent-core/src/`) | v2 destination | Relationship |
|---|---|---|
| `di/` | `_base/di/` | ported directly, plus new scope / fiber / service / collection |
| `base/common/event.ts` | `_base/event.ts` | same name |
| `errors/` | `_base/errors/` + root `errors.ts` | `KimiError` → `Error2`; `ErrorCodes` aggregated per domain |
| `logging/` | `_base/log/` | `getRootLogger()` → `ILogService` + `logSeed` |
| `telemetry.ts` | `app/telemetry/` | Client → Service |
| `flags/` | `app/flag/` | central registry → `registerFlagDefinition` + `IFlagService` |
| `config/` | `app/config/` + `app/kosongConfig/` + `app/projectLocalConfig/` | split; single-document schema → per-domain sections; `migrations.ts` → `app/config/migrations.ts` (same-named mechanism) |
| `loop/` | `agent/loop/` + `human/agent/` (the turn machine) | split |
| `mcp/` | `mcpCore/` (transport) + `app/mcpRegistry/` + `app/mcpConfig/` + `app/mcpManagement/` + workspace / session / agent-granular `mcp` | split |
| `plugin/` | `app/plugin/` + `agent/plugin/` + `agent/pluginCommand/` | same-name port + agent-granular split-off |
| `profile/` | `app/agentProfileCatalog/` + `workspace/workspaceAgentProfileLoader/` + `agent/profile/` + `session/sessionAgentProfileCatalog/` | split |
| `skill/` | `features/skill/` | feature-ized |
| `tools/` | `agent/tools/` + `tool/` + `agent/toolPolicy/` + `app/web/providers/` + `agent/media/` + `agent/task/` + `app/task/` + `features/cron/` | split; `store.ts` (`ToolStore`) gone |
| `rpc/` | → external packages: `packages/protocol` + `packages/kap-server` + `packages/klient` | left the engine entirely; `Emitter` / `Event` stay at `_base/event.ts` |
| `services/` (the 22-domain in-process service layer) | per-scope domain Services (same `createDecorator` convention), see A.3 | split by scope; `coreProcess/` gone (v2 is single-process) |
| `session/` | see A.3 | |
| `agent/` | see A.2 | |
| `utils/` | `_base/utils/` (proxy / retry / canonical-args and others under the same names) + individual homes | `tokens.ts` → `agent/tokenCounting/`; `per-id-json-store.ts` gone |
| `version.ts` | `_base/version.ts` | same name |

### A.2 v1 `agent/` subdomains

| v1 `agent/` | v2 destination |
|---|---|
| `background/` | `agent/task/` + `app/task/` + `agent/tools/task/` |
| `compaction/` | `agent/fullCompaction/` + `agent/contextMemory/compactionHandoff.ts`; `micro.ts` gone |
| `config/` | `llm-adapter/model/thinking.ts` + per-domain configSections (scattered) |
| `context/` | `agent/contextMemory/` + `agent/contextProjector/`; `dynamic-tools.ts` → `agent/toolSelect/dynamicTools.ts`; tool-result rendering → `agent/toolResultTruncation/` |
| `cron/` | `features/cron/` |
| `goal/` | `features/goal/` |
| `injection/` | `features/reminder/` + `agent/agentsMdReminder/` + `agent/interruptionReminder/` (prompt injection feature-ized; per-item mapping follows the code) |
| `permission/` | `agent/permissionGate` / `permissionMode` / `permissionPolicy` / `permissionRules/` (`matchesRule.ts` kept under the same name) + `session/sessionToolPolicy(Gate)/` + `session/approval/` + `session/question/` |
| `plan/` | `features/plan/` |
| `records/` | `wire/` (record / wireService / migration; protocol version 1.4 → 1.5) + `agent/blob/` + `persistence/interface/blobStore` |
| `replay/` | `agent/replayBuilder/types.ts` (types only); implementation left the engine |
| `skill/` | `features/skill/` |
| `swarm/` | `features/swarm/` |
| `tool/` | `agent/toolExecutor` / `toolRegistry` / `toolActivation` / `userTool/` + `tool/toolContract.ts` |
| `turn/` | `_base/utils/canonical-args.ts` + `llm-adapter/` + `human/agent/machine.ts` + `agent/media/mediaResolver.ts` + `agent/toolDedupe/` + `agent/toolResultTruncation/` |
| `usage/` | `agent/usage/` + `session/usage/` + `features/usage/` |
| `llm-request-recorder.ts` / `llm-request-logger.ts` | `llm-adapter/contract/request-trace.ts` + `agent/llmRequester/` |

### A.3 v1 `session/` and `services/`

| v1 `session/` | v2 destination |
|---|---|
| `store/` | `persistence/` (appendLog / atomicDocument / query store) + `app/sessionIndex/` + `app/workspace/` |
| `export/` | `app/sessionExport/` |
| `git-context.ts` | `session/agentLifecycle/profile/gitContext.ts` |
| `hooks/` | `features/externalHooks/` (app / session / agent tiers) |
| `provider-manager.ts` | `llm-adapter/provider/` + `app/kosongConfig/` |
| `subagent-*.ts` | `session/subagent/` |
| `rpc.ts` | → external packages: kap-server routes / klient |

The 22 domains of v1 `services/` land in v2 domain directories with the same semantics, organized by scope. Representative mappings: `approval` → `session/approval/`; `question` → `session/question/`; `event` → `app/event/`; `config` → `app/config/`; `session` → `app/sessionManager/` + `workspace/sessionLifecycle/`; `mcp` → `app/mcpManagement/`; `oauth` → `app/mcpConfig/` + `packages/oauth`; `fs` → `workspace/workspaceFs/`; `logger` → `_base/log/`; `terminal` → `os/interface/terminal.ts` + `session/terminal/`; `skill` → `features/skill/`; `modelCatalog` → `llm-adapter/model/catalog-service`; `message` → kap-server-side services (outside the engine); `coreProcess` → gone (v2 is in-process DI, with kap-server at the edge). The remaining domains follow the same `createDecorator` + `_serviceBrand` convention into the domain directory of their scope.

## Appendix B: node-sdk as a dual-engine coexistence example

At the baseline, node-sdk depends on both engines (`packages/node-sdk/package.json:62-63`), keeps its own public API unchanged, and branches internally by harness — a complete reference for "coexist first, then cut over cleanly":

- `src/sdk-rpc-client.ts` — the v1 harness: the `createKimiCore` path (`createKimiHarness` at line 145).
- `src/sdk-rpc-client-v2.ts` — the v2 harness body: imports `bootstrap` / `ensureKimiHome`, every `I*Service` token, `Error2 as V2Error2` / `ErrorCodes as V2ErrorCodes`, and the session helper family from the v2 root entry, plus a few deep-subpath imports (see 2.2).
- `src/v2/session-wiring.ts` — per-live-session event and interaction wiring (subscribing to each agent's `IEventBus` and forwarding).
- `src/v2/event-mapper.ts` — pure mapping from v2 `Event2` to the v1 SDK event shape.
- `src/v2/session-mapper.ts` — shape mapping between v2 `SessionMeta` and v1 `SessionSummary`.
- `src/v2/config-mapper.ts` — folds v2 per-domain config views back into the v1 `KimiConfig` single-document shape.
- `src/v2/import-context.ts` — reproduces v1 `ContextMemory.importContext`'s user message with v2 primitives.
- `src/v2/resume-replay.ts` — folds a v2 wire.jsonl with the help of the v1 implementation (depends on v1; outstanding debt, see the note in 2.3).
- `src/v2/global-mcp.ts` — session-level MCP validation reusing v1's `McpServerConfigSchema`.

## Sub-documents

- [migration/reference/symbol-map.md](migration/reference/symbol-map.md) — exhaustive mapping of all 714 unique v1 root-entry symbols to their v2 destinations, with same-name collisions and open verification items.
- [migration/reference/event-and-rpc-map.md](migration/reference/event-and-rpc-map.md) — the v1 CoreAPI method inventory and Event union members, and where each lands across klient / protocol / kap-server / IEventBus / Event2, plus the node-sdk v2 mapper rules.
- [migration/reference/wire-and-data.md](migration/reference/wire-and-data.md) — the wire migration chain, version determination and failure behavior, journal repair, the `~/.kimi-code` disk layout vs v1, and resume-replay's v1 dependency points.
- [migration/explanation/architecture.md](migration/explanation/architecture.md) — the v2 architecture explained for v1 readers: DI and services, LifecycleScope tiers, the Feature seam, and the migration history with key decisions.
- [migration/how-to/engine-lifecycle.md](migration/how-to/engine-lifecycle.md) — how to start, use, and shut down the v2 engine: bootstrap, accessor, Program, session controllers, helper functions, drain* order, and test setups.
- [migration/tutorials/first-consumer-migration.md](migration/tutorials/first-consumer-migration.md) — a guided tutorial for migrating your first consumer through the minimal read-config → session → prompt → events → shutdown loop.

Each sub-document has a zh-CN mirror under the same path with the `.zh-CN.md` suffix. An index in llms.txt format lives at [llms.txt](llms.txt).
