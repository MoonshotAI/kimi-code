# Topic — Telemetry

Telemetry infrastructure for agent-core-v2: how business services emit events, how context propagates, and how events reach a destination through appenders.

Telemetry is a **layer-1 root** domain (alongside `log`): the facade lives at `App` scope (a per-Agent ambient context service is bound at `Agent` scope), stateless, with no business-domain dependencies. It is a thin facade — enrichment, batching, and transport belong to the appenders, not to this layer.

## Where things live

- `src/app/telemetry/telemetry.ts`: contract — `ITelemetryService` (facade), `ITelemetryAppender` (destination), `TelemetryProperties`, `nullTelemetryAppender`, and `TelemetryServiceOptions`.
- `src/app/telemetry/events.ts`: event registry — `telemetryEventDefinitions` pairs every business event's property type with review metadata (owner / purpose / per-property comment); the single source of truth for `track2`. Agent-scope events register with `defineAgentTelemetryEvent<P>` and compose the ambient `AgentTelemetryEventContext` (`agent_id`) into their wire schema; all other events register with `defineTelemetryEvent<P>`.
- `src/app/telemetry/telemetryService.ts`: `TelemetryService` impl + `registerScopedService(LifecycleScope.App, …)`.
- `src/app/telemetry/agentTelemetryContext.ts` + `agentTelemetryContextService.ts`: `IAgentTelemetryContextService` — Agent-scoped mutable request context (`mode` / `provider_type` / `protocol` / `turn_id` / `trace_id`) snapshot into turn telemetry at launch. Agent identity (`agent_id`) is not part of it — identity is bound by the Agent-scoped `ITelemetryService` view.
- `src/app/telemetry/consoleAppender.ts`: `ConsoleAppender` — echoes events to a log function (dev / debug).
- `src/app/telemetry/cloudAppender.ts`: `CloudAppender` — sanitizes + PII-cleans properties, batches + enriches + posts to the telemetry endpoint.
- `src/app/telemetry/cloudTransport.ts`: `CloudTransport` — HTTP transport behind `CloudAppender`.
- `src/app/telemetry/privacy.ts`: outbound PII redaction (`cleanTelemetryProperties`) — URLs, emails, tokens, and absolute file paths become `<REDACTED: ...>` labels; `node_modules/` tails are kept.

## Emitting events (business services)

Inject `ITelemetryService` and call `track2` with a registered event:

```ts
import { ITelemetryService } from '#/app/telemetry/telemetry';

constructor(@ITelemetryService private readonly telemetry: ITelemetryService) {}

this.telemetry.track2('cron_fired', { task_id: taskId, coalesced_count: 0, stale: false, buffered: false, recurring: true });
```

`track2` is checked against the registry in `events.ts` at compile time: the event name must be a key of `telemetryEventDefinitions`, and the properties must match the registered interface exactly (extra or missing keys are compile errors). **New events must be registered first** — add a properties interface, then register it with `defineAgentTelemetryEvent<P>({ owner, comment, properties })` when every emission path goes through an Agent-scoped `ITelemetryService` view, or `defineTelemetryEvent<P>` otherwise (including events with any non-Agent emission path, e.g. `image_compress` from the kap-server prompt routes), documenting every property. For agent-scope events the registered interface is the business payload only: ambient `agent_id` is declared once in `AgentTelemetryEventContext` and composed into the wire schema, so it must not appear in the payload or at call sites. Naming: snake_case for events and properties, unit suffixes (`_ms` / `_count` / `_bytes`), no user content or file paths; `test/app/telemetry/events.test.ts` enforces the conventions. The low-level `track` remains for appender plumbing and tests only.

`TelemetryService.track` merges the bound context into the properties and fans the event out to every registered appender. A single throwing appender is isolated via `onUnexpectedError` and never blocks the rest.

### Context (sessionId / agent_id / turn_id)

The root service carries a bound context (`sessionId`) that is merged into every event, and each Agent scope gets its own telemetry view seeded with `agent_id` (by `agentLifecycle`), so Agent-scoped services emit their identity without call-site plumbing. Mutable per-agent request context (`mode` / `provider_type` / `protocol` / `turn_id` / `trace_id`) lives in `IAgentTelemetryContextService` and is snapshot into a per-turn view at turn launch. Derive a scoped view with `withContext`:

```ts
const child = telemetry.withContext({ agent_id: 'agent-0' });
child.track2('tool_call', { turn_id: 1, tool_call_id: 'c1', tool_name: 'bash', outcome: 'success', duration_ms: 12 });   // wire carries sessionId + agent_id
```

`withContext(patch)` returns a lightweight forwarding view: transport state (appenders, enabled flag) stays with the root, so later `addAppender` / `setEnabled` calls apply to every view, and per-call properties override bound context on key collision. `setContext(patch)` on the root mutates the root context and propagates to appenders that implement `setContext`; on a view it mutates only that view's own context.

## Appenders (destinations)

An appender is the destination an event is fanned out to. It is **not a DI Service** — it is a plain object implementing `ITelemetryAppender`, held by `TelemetryService`.

```ts
export interface ITelemetryAppender {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): ITelemetryAppender;
  setContext?(patch: TelemetryContextPatch): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}
```

Built-in appenders:

- `ConsoleAppender` — `[telemetry] <event> <json>` to a log function (default `console.log`); options `prefix` / `pretty` / `log`.
- `CloudAppender` — batches events, enriches with common context (`app_name` / `version` / `platform` / …), and posts to `https://telemetry-logs.kimi.com/v1/event` through `CloudTransport` (Bearer auth, retry, on-disk fallback). Options: `homeDir` / `deviceId` / `sessionId?` / `appName` / `version` / `uiMode?` / `model?` / `getAccessToken?` / `endpoint?` / `flushThreshold?` / `flushIntervalMs?`.

### Registering appenders (bootstrap)

Appenders are added after the App scope exists, by resolving the service and calling `addAppender`:

```ts
const app = createAppScope();
const telemetry = app.accessor.get(ITelemetryService);

telemetry.addAppender(new ConsoleAppender({ prefix: '[dev]' }));   // dev echo
telemetry.addAppender(new CloudAppender({                          // production
  homeDir, deviceId, sessionId,
  appName: 'kimi-code', version, uiMode: 'shell', model,
  getAccessToken: () => auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME),
}));
```

`addAppender` returns an `IDisposable` that removes the appender when disposed. `setAppender(appender)` resets to a single appender (mainly for tests). `removeAppender(appender)` drops one.

> There is no production bootstrap wired yet — `TelemetryService` defaults to `[nullTelemetryAppender]`, so `track(...)` is a no-op until `addAppender` is called at startup.

## Lifecycle

- `setEnabled(false)` drops `track` (service-level switch); `setEnabled(true)` resumes. `flush` / `shutdown` are unaffected by the switch.
- `flush()` / `shutdown()` fan out to all appenders concurrently; a single rejecting appender is swallowed. Await `shutdown()` before process exit so buffered events (e.g. in `CloudAppender`) are sent.

## Red lines (this topic)

- Business services depend only on `ITelemetryService` — never import an appender class.
- Telemetry is layer-1 root: do not inject any business-domain service into it, and keep the facade at `App` scope (only the ambient context service binds at `Agent`).
- Appenders are plain `ITelemetryAppender` objects, not DI Services — register them with `addAppender`, never via `registerScopedService`.
- `track` is fire-and-forget and must not throw; appender `track` must be synchronous — buffer and send asynchronously via `flush` / `shutdown`.
- Await `telemetry.shutdown()` before process exit when a buffering appender is registered.
- Keep event names stable; register every business event in `events.ts` and emit via `track2` — properties must be JSON-serializable primitives (non-primitives are dropped with a warning by `CloudAppender`).
- Agent identity is ambient: agent-scope events go through `defineAgentTelemetryEvent` and get `agent_id` from the scoped telemetry view — do not pass `agent_id` at business call sites (per-event identities such as `subagent_created` and the cron events are the exception).
