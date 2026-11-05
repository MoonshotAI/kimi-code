# Tutorial: migrate your first consumer

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8, v2 `@moonshot-ai/agent-core-v2` 0.4.3, and `@moonshot-ai/kimi-code-sdk` 0.20.0 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md); Chinese mirror: [`first-consumer-migration.zh-CN.md`](first-consumer-migration.zh-CN.md).

This tutorial assumes you have never touched v2. You maintain a consumer that depends on `@moonshot-ai/agent-core` (v1) — directly or through `@moonshot-ai/kimi-code-sdk` — and you will migrate the smallest closed loop: **read config → create session → send prompt → receive events → shut down**. By the end you will have a working v2 consumer and a checklist for the traps that the loop hides.

## 1. First, the good news: the public surface does not change

If your consumer talks to the engine through `@moonshot-ai/kimi-code-sdk`, the public surface is identical on both engines. Three layers prove it:

1. **`KimiHarness`** (`packages/node-sdk/src/kimi-harness.ts:82`) — both factories return the same class:
   - `createKimiHarness(options): KimiHarness` (`packages/node-sdk/src/sdk-rpc-client.ts:145`)
   - `createKimiHarnessV2(options): KimiHarness` (`packages/node-sdk/src/sdk-rpc-client-v2.ts:2732`)
   - Both take the same `KimiHarnessOptions` (`packages/node-sdk/src/types.ts:165-175`).
2. **`Session`** (`packages/node-sdk/src/session.ts:82`) — `harness.createSession()/resumeSession()` return the same `Session` class regardless of engine (`kimi-harness.ts:140-164, 205-226`).
3. **`SDKRpcClientBase`** (`packages/node-sdk/src/rpc.ts:183`) — `SDKRpcClient` (v1, `sdk-rpc-client.ts:48`) and `SDKRpcClientV2` (`sdk-rpc-client-v2.ts:374`) both extend it; it is publicly exported from `packages/node-sdk/src/index.ts:20`.

The base class carries the shared method surface (grouped, definition lines in parentheses; v2 has an `override` for each unless noted):

- **Session lifecycle**: `createSession` (199), `createSessionWithKaos` (206), `resumeSession` (216), `resumeSessionWithKaos` (221), `reloadSession` (231), `forkSession` (239), `closeSession` (250), `deleteSession` (255), `listSessions` (260), `listSessionsPage` (275), `renameSession` (299), `generateSessionTitle` (311, v1 throws `not_implemented`), `exportSession` (319), `updateSessionMetadata` (667), `addAdditionalDir` (599), `listWorkspaceSkills` (280), `suggestFiles` (866, v1 returns `undefined`), `getWorkspaceTrustInfo`/`trustWorkspace` (290/295, v1 always trusted/no-op).
- **Config**: `getConfig` (331), `getConfigDiagnostics` (336), `setConfig` (346), `removeProvider` (351), `supportsAtomicSectionReplace` (361, false on v1), `replaceConfigSections` (372, v1 throws), `getExperimentalFeatures` (341).
- **Files**: `uploadFile`/`deleteFile` (385/392, v1 throws `not_implemented`).
- **prompt / turn**: `prompt` (531), `promptWithSkills` (546, v1 throws), `steer` (579), `runShellCommand` (554), `cancelShellCommand` (569), `cancel` (613), `swarm` (696), `setSwarmMode` (691), `setTowerMode` (701, v1 throws), `generateAgentsMd` (589), `getSessionWarnings` (594), `startBtw` (604), `activateSkill` (1060), `activatePluginCommand` (1070), `listCommands`/`runCommand` (1088/1093, v1 empty array/throws), `getRuntime`/`switchRuntime` (1101/1106, v1 throws).
- **State reads**: `setModel` (640), `setThinking` (649), `setPermission` (658), `setPlanMode` (677), `getPlan` (728), `clearPlan` (736), `compact` (744), `cancelCompaction` (753), `undoHistory` (769), `clearContext` (622), `importContext` (630), `getContext` (778), `getUsage` (786), `getStatus` (794), `getTodos` (761, v1 throws), `listSkills` (842).
- **goal / cron / background tasks**: `createGoal`/`getGoal`/`pauseGoal`/`resumeGoal`/`cancelGoal` (929-966), `getCronTasks` (968), `listBackgroundTasks` (872), `getBackgroundTaskOutput` (884), `stopBackgroundTask` (896), `detachBackgroundTask` (908), `waitForBackgroundTasksOnPrint` (919), `handlePrintMainTurnCompleted` (924).
- **MCP**: the 17 management methods `listGlobalMcpServers` etc. (399-529), `listMcpServers` (973), `listWorkspaceMcpServers` (984, v1 empty array), `getMcpStartupMetrics` (989), `reconnectMcpServer` (994), `addSessionMcpServer` (1008).
- **Plugins**: `listPlugins`/`installPlugin`/`setPluginEnabled`/`setPluginMcpServerEnabled`/`removePlugin`/`reloadPlugins`/`getPluginInfo` (1021-1058), `listPluginCommands` (847), `listPluginCommandsGlobal` (857, v1 empty array).
- **Events and callbacks (engine-agnostic, the base class's own registry, overridden by neither client)**: `onEvent` (1111), `receiveEvent` (1118), `setApprovalHandler` (1124), `setQuestionHandler` (1132), `clearSessionHandlers` (1140), `requestApproval` (1145), `requestQuestion` (1172), `toolCall` (1191), `withInteractiveAgent`/`interactiveAgentId` (189-195).

Mechanical check: v2 has **106 `override`s**; the only base-class methods v2 does not override are the event/handler registry above (engine-agnostic) + `createSessionWithKaos`/`resumeSessionWithKaos` (deliberately left at the base-class degraded behavior, see pit #5 in §4). v1's `SDKRpcClient` overrides only the two kaos variants (`sdk-rpc-client.ts:115,125`); everything else goes through the base class → `getRpc()` → the v1 RPC.

The two clients' own public fields/methods (the construction surface):

| Member | v1 `SDKRpcClient` | v2 `SDKRpcClientV2` |
|---|---|---|
| Fields | `homeDir/configPath/identity/telemetry/auth/core` (`sdk-rpc-client.ts:49-54`) | `homeDir/configPath/identity/telemetry/auth/klient` (`sdk-rpc-client-v2.ts:375-380`) |
| Options type | `SDKRpcClientOptions` (32-46, extra `resolveOAuthTokenProvider`) | `SDKRpcClientV2Options` (351-365) |
| `ensureConfigFile()` | 92-94 | 499-508 |
| `close()` | 96-109 | 510-535 |
| v2-only public additions | — | `engineAccessor` getter (608), `suppressEngineSessionStarted()` (578), `enabledExperimentalFlags()` (591), `listCapabilities`/`getCapability`/`installCapability` (880-890) |

**Concluding fact**: an un-overridden method on v2 cannot silently take a wrong path — `SDKRpcClientV2.getRpc()` throws `KimiError(ErrorCodes.NOT_IMPLEMENTED, 'This SDK method is not wired to agent-core-v2 yet.')` directly (`sdk-rpc-client-v2.ts:612-617`); the v2 file's header comment (lines 1-136) defines the migration model: "the base class carries the v1 method surface; whatever is not overridden fails loudly."

## 2. The minimal loop, side by side

### 2.1 The consumer-level skeleton (the only difference between v1 and v2 is the first line)

The repo already has a matching real example, `packages/node-sdk/examples/kimi-harness-prompt-demo.ts` (v1 style, 137 lines), which this skeleton is lifted from:

```ts
// v1: import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
// v2: swap only the factory function (same package, same types):
import { createKimiHarnessV2 as createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

const harness = createKimiHarness({ identity, homeDir });        // ① build the harness
const config = await harness.getConfig();                        // ② read config
const model = config.defaultModel;
const session = await harness.createSession({ workDir, model }); // ③ create a session
const unsubscribe = session.onEvent((event) => {                 // ④ subscribe to events
  if (event.type === 'turn.ended') { /* turn finished */ }
  if (event.type === 'assistant.delta') { /* streaming output */ }
});
await session.prompt('Hello');                                   // ⑤ send a prompt
await session.close();                                           // ⑥ close the session
await harness.close();                                           // ⑦ close the harness
```

The real signature behind each line:

- Factories: `createKimiHarness` (`sdk-rpc-client.ts:145-159`) / `createKimiHarnessV2` (`sdk-rpc-client-v2.ts:2732-2756`), taking `KimiHarnessOptions` (`types.ts:165-175`).
- `harness.getConfig()` (`kimi-harness.ts:434-436`).
- `harness.createSession(options)` (`kimi-harness.ts:140-164`), `CreateSessionOptions` (`types.ts:177-207`, only `workDir` required).
- `session.onEvent(listener)` (`session.ts:122-129`, filters by `event.sessionId === this.id` and returns an `Unsubscribe`); the event union type is exported from `packages/node-sdk/src/events.ts:9` (`Event` comes from the v1 protocol).
- `session.prompt(input)` (`session.ts:141-151`; the `promptId` option takes effect on v2 only, see pit #7 in §4).
- `session.close()` (`session.ts:744-753`), `harness.close()` (`kimi-harness.ts:631-634`).
- The idiom for awaiting events is in the example `kimi-harness-prompt-demo.ts:37-56` (await `turn.ended` + reject on `error` + timeout); the same helper exists in tests as `waitForSDKEvent` (`packages/node-sdk/test/session-runtime-helpers.ts:54-73`).

A real consumer switching example (the CLI): `apps/kimi-code/src/cli/run-shell.ts:87-90` — `isKimiV2Enabled()` decides between `createKimiHarnessV2(harnessOptions)` and `createKimiHarness(harnessOptions)`, same `harnessOptions`. The switch is defined in `apps/kimi-code/src/cli/experimental-v2.ts`: `KIMI_CODE_LEGACY_FLAG` truthy → v1, default v2 (lines 14, 31-35).

### 2.2 What changed underneath (the "what did the engine swap" table)

| Step | v1 path | v2 path |
|---|---|---|
| Construction | `new SDKRpcClient`: `createRPC<CoreAPI,SDKAPI>()` + in-process `new KimiCore(...)` (`sdk-rpc-client.ts:77-89`) | `new SDKRpcClientV2`: `bootstrap({homeDir, configPath, clientIdentity, args})` + `createKlient({scope: app})` over the memory transport (`sdk-rpc-client-v2.ts:451-469`) |
| Read config | base class `getConfig` → `rpc.getKimiConfig` (`rpc.ts:331-334`) | `await this.configReady` → `klient.global.config.getAll()` → `resolvedConfigToKimiConfig` pure mapping (`sdk-rpc-client-v2.ts:745-751`; `v2/config-mapper.ts:56-65`) |
| Create session | base class `createSession` → `rpc.createSession` (`rpc.ts:199-204`) | `ISessionManager.create({sessionId, workDir, additionalDirs})` + `wireSession(handle)`; `model/thinking/permission` triggers main-agent materialization and profile binding (`sdk-rpc-client-v2.ts:1320-1370`) |
| Send prompt | base class `prompt` → `rpc.prompt({sessionId, agentId, input})`, `agentId` from AsyncLocalStorage (`rpc.ts:531-539`) | `klient.session(id).agent(id).prompt(...)`, first going through `agentFacade` to ensure the main agent is materialized (`sdk-rpc-client-v2.ts:1971-1978`, 1724-1727) |
| Receive events | the v1 engine calls back via the RPC `ClientAPI.emitEvent` → `receiveEvent` (`rpc.ts:1200-1205`) | `SessionEventWiring` subscribes to each agent's `IEventBus`, `translateDomainEvent` stamps `sessionId/agentId` and feeds the same `receiveEvent` (`v2/session-wiring.ts:153-166`; `v2/event-mapper.ts:65-79`) |
| Shutdown | `core.shutdown()` + logger flush, exceptions swallowed (`sdk-rpc-client.ts:96-109`) | wiring/subscription dispose → `klient.close()` → `ISessionIndexMirror.drain()` → `IMcpOAuthService.shutdown()` → `app.dispose()` + three drains (`sdk-rpc-client-v2.ts:510-535`) |

Additional fact: the v2 engine bootstraps in-process, but every facade call still goes through the klient memory transport's contract validation and JSON round-trip (the header comment of `sdk-rpc-client-v2.ts`, lines 1-7; `createKlient` comes from `@moonshot-ai/klient/memory`, line 248).

## 3. Test infrastructure

### 3.1 Pointing vitest aliases at package sources

- `packages/node-sdk/vitest.config.ts:5-21`: `resolve.alias` maps `@moonshot-ai/agent-core` → `../agent-core/src/index.ts`, `@moonshot-ai/kimi-code-oauth` → `../oauth/src/index.ts`; `test.name: 'kimi-sdk'`, env `KIMI_LOG_LEVEL: 'off'`, `include: ['test/**/*.test.ts']`.
- **Why only these two need aliases**: the other packages' `exports` already point at sources — `@moonshot-ai/kimi-code-sdk` itself `"."` → `./src/index.ts` (`packages/node-sdk/package.json:32-37`), `@moonshot-ai/agent-core-v2` `"."` and `"./*"` → `./src/*.ts`, `@moonshot-ai/klient` (including the `/memory`, `/ipc` subpaths) likewise → `./src/*.ts` (each package's package.json). So an in-monorepo consumer (e.g. `apps/kimi-code/vitest.config.ts`) only aliases its own `@` → `src`, no package aliases needed.
- A side effect of aliasing (worth a reminder in a tutorial): the comments at `v2/session-mapper.ts:24-29` and `v2/resume-replay.ts:77-79` explain — aliasing to the package index swallows deep-subpath imports, so `normalizeWorkDir` is byte-copied inside the SDK and the in-memory persistence is a local implementation.

### 3.2 Fake / in-memory backends for not starting a real engine

There is **no standalone fake-engine package** in the repo; two established patterns:

1. **Stub the base class (no engine at all)**: `SDKRpcClientBase` is publicly exported (`index.ts:20`), and tests subclass it directly:
   - `packages/node-sdk/test/kimi-harness.test.ts:24-40`: `class StubRpc extends SDKRpcClientBase`, `getRpc()` throws `'no core calls expected'`; `makeHarnessWithRpc` shows how to hand-build `new KimiHarness(rpc, {...})` with minimal options.
   - Same pattern: `test/create-session-transport.test.ts:71`, `test/session-prompt-input.test.ts:7` (`CapturingRpc`), `test/mcp-config.test.ts:759` (`OAuthRpc`).
   - The base class carries its own `onEvent`/`receiveEvent`/approval/question registries (`rpc.ts:1111-1196`), so calling `receiveEvent(fakeEvent)` in a stub injects events — the lightest path for consumer unit tests.
2. **A real engine + a temporary home (no provider)**: the repo's integration-test pattern points `KIMI_CODE_HOME` at an `mkdtemp` and never touches the network:
   - `packages/node-sdk/test/v1-v2-parity.test.ts:537-543` (`makeParityPair`): both `createKimiHarness` + `createKimiHarnessV2` over the same fixture home — this is exactly the repo-level way to verify migration correctness; the header comment (lines 1-11) states "no provider calls".
   - `packages/node-sdk/test/sdk-rpc-client-v2.test.ts:99-103` (`makeHarness`, v2 only).
   - Supporting utilities: `test/test-identity.ts` (a fixed `KimiHostIdentity`), `test/telemetry.ts` (`recordingTelemetry` in-memory telemetry), `test/session-runtime-helpers.ts` (`makeTempDir`/`removeTempDirs`/`waitForSDKEvent`/helpers for reading `wire.jsonl`).
   - Deleting the temp directory after a v2 engine close races the async drains: `sdk-rpc-client-v2.test.ts:79-87`'s afterEach runs `drainSessionIndexMirror()` + `drainQueryStoreDisposals()` before `rm` (the ENOTEMPTY lesson, also see the comment at `sdk-rpc-client-v2.ts:519-534`).
3. **`@moonshot-ai/klient/memory` transport is not a fake**: `createKlient({scope})` still bootstraps a real v2 engine; only the transport is in-process (`sdk-rpc-client-v2.ts:248,469`). Do not describe it as a mock.

## 4. The migration pit list (all drawn from `src/v2/*` and v2-client comments/implementations)

1. **Time formats epoch ↔ ISO, and the time source changed too**:
   - v2 `SessionMeta` stores epoch-ms in fields named `createdAt/updatedAt`; v1 `SessionMeta` stores ISO strings. Conversion happens in `v2MetaToSessionMeta`: `new Date(meta.createdAt).toISOString()` (`packages/node-sdk/src/v2/session-mapper.ts:68-71`, header comment lines 8-9).
   - `SessionSummary`-level timestamps are passed through without format conversion (`session-mapper.ts:54-55`), but the two engines **source them differently**: v1 reads the session directory's fs birth/mtime, v2 reads metadata stamps — the parity test therefore does not compare `createdAt/updatedAt` (KNOWN_DIFFS comment in `test/v1-v2-parity.test.ts`, lines 243-253).
2. **`workDir` ↔ `cwd`**: v2 `SessionMeta.cwd` ↔ v1 `SessionMeta.workDir` (`session-mapper.ts:76`); in list scenarios workDir comes from `item.cwd ?? workspace.root` (`sdk-rpc-client-v2.ts:1282`). Normalization must be byte-identical to v1: `normalizeWorkDir` (`session-mapper.ts:30-35`) is a mirror of v1 `agent-core/session/store/workdir-key`; an empty workDir re-creates v1's rejection `REQUEST_WORK_DIR_REQUIRED` on the v2 side (`sdk-rpc-client-v2.ts:2759-2764`).
3. **Events carry no `sessionId`/`agentId` stamps**: the v2 bus is per-agent; events do not carry those fields. The SDK stamps them in `translateDomainEvent(event, sessionId, agentId)` (`v2/event-mapper.ts:65-79`, header comment lines 5-9; call site `v2/session-wiring.ts:155-164`). Same layer: the dropped v2-only type list (`event-mapper.ts:31-44`, including `prompt.*`, `agent.activity.updated`, `permission.approval.*`), `task.started/terminated` renamed back to the v1 spelling `background.task.*` (52-55), `turn.started` stripped of the internal field `promptAttachments` (72-77), only `session.meta.updated` forwarded from the process-global bus (89-95; `sdk-rpc-client-v2.ts:477-486`), `agent.status.updated` completed at the edge with usage/context/model snapshots (`session-wiring.ts:283-311`).
4. **The `KimiError` shape is preserved**: the v2 engine throws `Error2`; the SDK's public contract is `KimiError` (branchable with `isKimiError`, re-exported from `index.ts:47-58`). Bridge points:
   - The MCP management surface uniformly `restateMcpManagementError`: Error2 → `KimiError` with same code/message/details; undeclared new codes degrade to `internal` (otherwise `toKimiErrorPayload` serialization blows up) (`sdk-rpc-client-v2.ts:2766-2784`).
   - `sessionNotFound` re-creates the v1 shape field by field (`SESSION_NOT_FOUND` + `details.sessionId`, 997-1001); `deleteSession` restates after catching the engine's not-found (1460-1478).
   - The `getRpc()` fallback throws `KimiError(NOT_IMPLEMENTED)` (612-617).
   - Non-Error2 failures (DI resolution bugs, aborts) pass through unchanged (comment 2770-2771).
5. **The kaos injection point is gone**: v1's `SDKRpcClient.createSessionWithKaos/resumeSessionWithKaos` really wire kaos into the core (`sdk-rpc-client.ts:115-134`); the v2 engine has no injection point, and the base-class degraded behavior is kept deliberately — **silently ignoring the kaos argument** while running a local create/resume (header comment of `sdk-rpc-client-v2.ts` lines 131-135 + the session-lifecycle section header lines 924-932; base implementations `rpc.ts:206-229`). A consumer passing a custom kaos will silently change behavior after migrating.
6. **The ready trap (config-read timing)**: the v2 engine's config/model/provider reads are synchronous, but the underlying state must settle its initial load first; the v2 client captures `configReady` (`IConfigService.ready`) and `modelReady` (config+model+provider together) at construction (`sdk-rpc-client-v2.ts:383-408`), and every config/agent override method awaits them first. `ensureConfigFile()` on Windows additionally waits for `IHostEnvironment.ready` (Git Bash probing) (499-508). A consumer escaping directly through `engineAccessor` must keep this discipline itself.
7. **`promptId` takes effect on v2 only**: the `SessionPromptRpcInput.promptId` doc says "Honored by the v2 RPC client only" (`rpc.ts:91-96`); v1 ignores it.
8. **Prompt-enqueue semantics differ (pinned in migration tracking)**: v1 drops a prompt received mid-turn (emitting only an error event); v2 FIFO-queues it (comment at `sdk-rpc-client-v2.ts:1967-1970`).
9. **`getContext().tokenCount` semantics differ**: v1 reports a running estimate; v2 reports the provider-measured prefix (0 before the first LLM turn) (comment at `sdk-rpc-client-v2.ts:1796-1804`); after `importContext`, v1 adopts the estimate as the reported value while v2 has no public setter, so readings diverge from then on (comment 1932-1936; KNOWN_DIFFS `getContext`, `v1-v2-parity.test.ts:274-285`).
10. **Default titles**: the v1 store materializes `'New Session'` into state.json and reports it; v2 keeps no default title (KNOWN_DIFFS, `v1-v2-parity.test.ts:243-253`). Fork default titles differ: v1 "New Session" vs v2 "Fork: <source>" (comment at `sdk-rpc-client-v2.ts:1415-1417`).
11. **Live-session constraints**: `updateSessionMetadata` only serves live sessions on both sides (v1 404s on closed sessions via the live-session path; v2 mirrors with `requireLiveSession`) (`sdk-rpc-client-v2.ts:1578-1588`); most agent-interaction methods likewise require live (comment 1650-1663).
12. **Session directory / persistence layout differs**: v2 keeps one `wire.jsonl` per agent (`<sessionDir>/agents/<agentId>/wire.jsonl`), and replay folding reuses the v1 restore pipeline (header comment of `v2/resume-replay.ts`, lines 1-54); `exportSession`'s zip entry list is explicitly **outside** the parity surface (comment at `sdk-rpc-client-v2.ts:1621-1623`). Consumers reading the directory directly (e.g. the `state.json`/`wire.jsonl` tricks in `examples/kimi-harness-smoke.ts:28-48`) cannot be carried over as-is.
13. **Plugin hook event union difference**: the v2 engine's hook event union is a superset of v1's; `getPluginInfo`'s projection drops hook events v1 does not know (`sdk-rpc-client-v2.ts:855-872`).
14. **Know the failure shape of v2-only capabilities up front**: `generateSessionTitle`, `promptWithSkills`, `setTowerMode`, `getTodos`, `uploadFile`/`deleteFile`, `replaceConfigSections`, `runCommand`, `getRuntime`/`switchRuntime` throw `KimiError(NOT_IMPLEMENTED)` on the v1 client (base class `rpc.ts:311-317, 372-397, 546-552, 701-707, 761-767, 1093-1109`); the capability surface is probed via the `capabilityRpc` struct, which throws `TypeError('...requires v2')` on v1 (`session.ts:70-80`). A dual-engine consumer must catch these.
15. **Shutdown order**: v2's `close()` must drain in order (mirror → OAuth shutdown → dispose → the three global drains), or the host deleting homeDir hits ENOTEMPTY (`sdk-rpc-client-v2.ts:510-535`; the test-side afterEach does the same, `sdk-rpc-client-v2.test.ts:79-87`).

## 5. How to verify the migration

1. **Parity harness**: run your consumer's flow on both engines over the same fixture home — the repo's own pattern is `makeParityPair` (`packages/node-sdk/test/v1-v2-parity.test.ts:537-543`), which boots `createKimiHarness` and `createKimiHarnessV2` side by side with no provider calls. Compare observable behavior, not internals; the known, accepted differences are pinned in that file's KNOWN_DIFFS (lines 191-368; see the open items below for coverage caveats).
2. **No v1 references left**: `rg "@moonshot-ai/agent-core"` in your package returns zero hits (watch for false matches from the `agent-core-v2` prefix), and your build/typecheck passes.
3. **Real data**: boot v2 once against a real session directory and confirm journal migration, replay rebuild, and config reads (see [`../reference/wire-and-data.md`](../reference/wire-and-data.md) for what the read path does).
4. **Event flow**: with the loop from §2, confirm you still receive `assistant.delta` / `turn.ended` (they are stamped with `sessionId`/`agentId` by the SDK's event-mapper) and that errors surface as `KimiError`, not `Error2`.

## Open verification items

1. **`KimiHarnessOptions.autoLoadConfig` looks like a dead option**: declared at `types.ts:169`, with no reference anywhere in `src/` (neither client nor KimiHarness reads it). Whether it is consumed on the daemon-client host side (outside this package) — unverified.
2. **`CreateSessionOptions.agentProfile/agentFiles` (`types.ts:192-197`) and `ResumeSessionInput.agentProfile` (228) are silently dropped by v2**: the v1 base class passes `coreInput` through to the engine (`rpc.ts:199-204`); v2's `doCreateSession` only passes `{sessionId, workDir, additionalDirs}` (`sdk-rpc-client-v2.ts:1343-1347`), resume only passes `additionalDirs` (1496-1499); the `agentProfile !== undefined` branch at `kimi-harness.ts:181` is a no-op for v2. Whether this is pinned in migration tracking — unverified (the v2 client's createSession comment at 1306-1319 does not mention it).
3. **The exact format of `SessionSummary.createdAt/updatedAt` on the v1 line** (ISO or epoch): §4 pit #1 only confirmed "different sources, parity does not compare" and the meta-level epoch→ISO conversion; the v1 `SessionSummary` type declaration itself was not opened (it lives in `agent-core`'s session/store). Check it before hard-coding the format.
4. **The full KNOWN_DIFFS list**: `test/v1-v2-parity.test.ts:191-368` — only the first ~180 lines were verified (flag/config/plugin/session/resume/context/plan/status/goal/background/MCP entries); the remaining section (339-368 and call sites after line 2010) was not expanded entry by entry; if the tutorial needs a full known-differences appendix, read lines 340-460 of that file.
5. **Post-baseline drift (unverified)**: the v1-side references `packages/node-sdk/src/sdk-rpc-client.ts`, `packages/node-sdk/test/kimi-harness.test.ts`, `packages/node-sdk/test/v1-v2-parity.test.ts`, and `apps/kimi-code/src/cli/experimental-v2.ts` were verified at the declared baseline `ccf3d5d6`; in the current workspace checkout (main after #3542) they no longer exist — they were deleted together with v1 (#3542, the remove agent-core v1 work item, which also renamed `createKimiHarnessV2` to `createKimiHarness` as the sole factory). The tutorial's v1-side line numbers remain baseline facts; their post-deletion successors are pending verification.
