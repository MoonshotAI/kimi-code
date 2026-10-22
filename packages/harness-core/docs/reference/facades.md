# Facades Reference

Every facade token exposed by harness-core features and transports. The
**Level** column says which unit exposes the face — that determines where it
can be `useInject`ed (same level or below in the lineage) and which helper
resolves it from outside (`sessionFacade` for session, `agentFacade` for
agent, root resolution for app).

Injection always yields `Readonly<ShallowRef<Face | undefined>>` — see
[Architecture](../explanation/architecture.md#facades-useexpose--useinject).

## Product Features

| Token | Feature | Level | The face |
|---|---|---|---|
| `TodoRef` | todo | agent | `{ items, state }` — the current todo list and its projection state |
| `InteractionRef` | interaction | session | `Interactions` — request/enqueue/respond/findAll/wait for approval, question, and user-tool interactions (helper: `useInteractions()`) |
| `PermissionModeRef` | permission.mode | session | `{ state, mode, setMode }` — permission mode, one state shared by every agent of the session |
| `PermissionPolicyRef` | permission | session | `{ state, recordApprovalResult, addRules }` — permission rules and session approval history, one state shared by every agent of the session |
| `PlanRef` | plan | agent | `{ state, enter, cancel, clear, exit, recordRevision, status }` — plan mode control |
| `CronRef` | cron | agent | `{ tasks, now, isDisabled, addTask, removeTasks, getTask, list, isStale, getNextFireForTask, computeDisplayNextFire, tick }` |
| `TaskRef` | task | agent | `{ records, stop, detach }` — background task tracking |
| `SkillCatalogRef` | skill | app | `{ ready, list, get, renderSkillPrompt, getModelSkillListing, getKimiSkillsDescription, listInvocableSkills, roots, skipped, reload }` — the skill catalog |
| `SkillRef` | skill | agent | `{ activate, promptWithSkills }` — run a skill in this agent |
| `PluginRef` | plugin | app | plugin management — `listPlugins`, `installPlugin`, `setPluginEnabled`, `removePlugin`, `reloadPlugins`, `getPluginInfo`, `checkUpdates`, … plus `lastMutation` / `lastReload` refs |
| `McpRef` | mcp | app | `McpFacade` — MCP server management (`list`, `connect`, `disconnect`, `reconnect`, `reload`, …) |
| `ProviderCatalogRef` | provider-catalog | app | the provider catalog — provider/model lookup, requester binding, `addProvider`, `addModel`, `refresh`, awaitable `ping`, retired-model lookup, and change/refresh-failure/retirement listeners |
| `ModelDefaultsRef` | provider-catalog | app | `{ setDefaultModel, setDefaultThinking }` — persisted app-wide defaults |
| `SessionModelRef` | provider-catalog | session | `{ setModel, setThinking }` — session-level model defaults |
| `AgentModelRef` | provider-catalog | agent | `{ current, setModel, setThinking }` — this agent's model binding |
| `CompactionRef` | compaction | agent | `{ compact, cancel, status }` — context compaction control |
| `UndoRef` | undo | agent | `{ availability, undo(turns) }` — turn rewind |
| `BtwRef` | btw | session | `{ create, list, isBtw }` — by-the-way side questions to a read-only subagent |
| `UsageRef` | usage | agent | `{ usage, total }` — accumulated token usage |
| `TimingRef` | timing | agent | `{ timing }` — current LLM request timing |
| `TokenCountingRef` | tokenCounting | agent | `{ status, get, statusSize, latestMeasured, requestSize }` — context size accounting |
| `TowerRef` | tower | agent | `{ state, isActive, requestedBase, enter, exit }` — tower mode |
| `TowerRateLimitRef` | tower | app | the shared tower rate limiter |
| `ShellCommandRef` | shellCommand | agent | `{ run, cancel }` — host `!` shell commands |
| `WorkspaceRef` | workspaces | app | workspace registry — `list`, `get`, `findByRoot`, `createOrTouch`, `openSession`, `update`, `delete`, trust management, `sessionCount`; plus `state` and an optional `fs` face |
| `CapabilitiesRef` | capabilities | app | `{ list, get, install }` — installable capabilities |
| `CapabilityPluginsRef` | capabilities | app | the plugins port capability entries use (exposed by the plugin bridge) |
| `ConfigRef` | config | app | `ConfigStore` — `get`, `section`, `env`, `set`, `replace`, `reload`, `diagnostics` |
| `TelemetryRef` | telemetry | app + session + agent | `{ track, setContext, getContext, setEnabled, flush, shutdown, events }` — exposed at all three levels; the nearest exposure scopes the context |
| `SessionIndexRef` | sessionIndex | app | `{ get, list, listByWorkspace, listAll }` — the searchable session index |
| `SessionExportRef` | sessionExport | app | `{ export }` — export a session archive |
| `SessionInitRef` | sessionInit | session | `{ generateAgentsMd, cancelInit }` — AGENTS.md initialization |
| `FilesRef` | files | app | `{ save, open }` — the global staged upload library |
| `KimiFileRegistryRef` | files | session | `{ put, get, open, materialize }` — session-owned `kimi-file://` references, backed by durable ID-to-blob mappings |
| `FileHistoryRef` | fileHistory | agent | `{ history, settled, captureForActiveTurn, changes, turnRecorded }` — per-turn file snapshots |
| `ProfileCatalogRef` | profiles | app | the agent-profile catalog (`ready`, `reload`, plus `ProfileCatalog`) |
| `ModelsDevRef` | models-dev | app | `{ listProviders, getProvider, importProvider, importRegistry, refreshRegistries }` — models.dev imports |
| `ExternalHooksRunnerRef` | externalHooks | app | `{ summary, trigger, fireAndForgetTrigger, hasHooksFor }` — run external hooks |
| `AgentsMdReminderRef` | agentsMdReminder | agent | `{ seed }` — seed AGENTS.md paths for the reminder |
| `BashRef` | os | agent | `BashPendingDetach` — `{ running, detach }` for background bash calls |
| `SpawnRegistryRef` | spawn | session | `SpawnRegistry` (`Map<string, SpawnRecord>`) — spawned subagent runs |
| `SessionTitleRef` | kimi/sessionTitle | session | `{ generateTitle }` — LLM-generated session titles |
| `SessionTitlePromptSourceRef` | kimi/sessionTitle | agent | `{ compose }` — custom title-prompt composition |
| `TraceRef` | kimi/trace | agent | `{ traceId }` — the current LLM trace id |
| `WebSearchRef` | kimi/web | app | `{ getProvider }` — the web search provider behind the tool |
| `WebFetchRef` | kimi/fetch | app | `{ getUrlFetcher }` — the URL fetcher behind the tool |
| `OAuthTokensRef` | kimi/oauth | app | `OAuthTokens` — `resolve`, `hasCachedAccessToken`, `refresh`, `loginStart`, `loginStatus`, `loginCancel`, `logout`, `usage`, `userinfo`, `region`, `summary` |

`ProviderCatalogRef.refresh` accepts `{ providerId?, scope?: 'all' | 'oauth' }`
and resolves to a `ProviderRefreshReport` with `changed`, `unchanged`, `failed`,
and optional `retired_default`. `ping(providerId, modelId)` resolves to a
`ProviderCatalogPingResult` (`ok`, `durationMs`, `text?`, `usage?`,
`finishReason?`, `error?`); unknown models and a not-yet-ready catalog reject.

Features without a facade (`wait-for`, `edit`, `media`, `swarm`,
`tool-select`, `toolDedupe`, `dateChange`, `notify`, `ptc`) contribute
behavior only — tools, prompt sections, hooks — and expose no token.

## Transports

| Token | Feature | Level | The face |
|---|---|---|---|
| `HttpRef` | http | app | the `Http` server — `route`, `upgrade`, `listen`, `close`, `origin` |
| `WsRegistryRef` | http | app | the WebSocket endpoint registry (`list`) |
| `WsV1BroadcasterRef` | http | app | the v1 session-state broadcaster |
| `AcpConnectionRef` | acp | app | `{ client, capabilities }` — the ACP client connection |
| `RemoteControlRef` | remote-control | app | `{ status, enable, disable }` — the remote-control tunnel |

## Collection Tokens

Not facades, but part of the contribution surface (`useContribute` /
`useCollection`):

| Token | Feature | Content |
|---|---|---|
| `Providers` | provider-catalog | `ProviderContribution`s — provider handles and optional init info |
| `ProviderProtocols` | provider-catalog | protocol factories per provider `type` |
| `ProviderRefreshers` | provider-catalog | refresh channels returning `config key → complete model record` |
| `CatalogModels` | provider-catalog | the resolved `CatalogModelBinding` list |
| `CredentialResolvers` | provider-catalog | credential providers per provider info |
| `ConfigSections` / `ConfigOverlays` | config | declared config sections / env overlays |
| `TelemetryEvents` | telemetry | declared telemetry event definitions (`useTelemetryEvents`) |
| `SkillSources` | skill | extra skill catalog sources |
| `McpServerSources` | mcp | extra MCP server config sources |
| `PtcToolGuards` | ptc | guards for tools callable from PTC code |
| `HookSources` | externalHooks | external hook sources |
| `ProfileFinders` | profiles | profile discovery finders |
| `HttpRoutes` | http | contributed HTTP routes (`useHttpRoute`) |
| `SessionActionContributions` | http | contributed session actions for the HTTP API |
