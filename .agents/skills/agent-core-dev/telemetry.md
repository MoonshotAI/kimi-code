# Topic — Telemetry

Telemetry infrastructure for agent-core-v2: how business services emit events, how context propagates, and how events reach a destination through appenders.

Telemetry is a **layer-1 root** domain (alongside `log`): the facade lives at `App` scope, stateless, with no business-domain dependencies. It is a thin facade — enrichment, batching, and transport belong to the appenders, not to this layer.

## Where things live

- `src/app/telemetry/telemetry.ts`: contract — `ITelemetryService` (facade), `ITelemetryAppender` (destination), `TelemetryAppenderRecord`, `nullTelemetryAppender`, `noopTelemetryService`.
- `src/app/telemetry/context.ts`: the ambient context model — `SessionTelemetryContext` / `AgentTelemetryContext` / `TurnTelemetryContext` tiers and the closed `TelemetryContextPatch` (unknown keys are compile errors), plus `TelemetryPrimitive` / `TelemetryProperties`.
- `src/app/telemetry/events.ts`: event registry — `telemetryEventDefinitions` pairs every business event's property type with review metadata (owner / purpose / per-property comment); the compile-time contract for `track2`. Agent-scope events register with `defineAgentTelemetryEvent<P>` and document the ambient `AgentTelemetryEventContext` (`agent_id`); all other events register with `defineTelemetryEvent<P>`.
- `src/app/telemetry/telemetryService.ts`: `TelemetryService` impl + scope binding (`bindTelemetryScope`, `BoundTelemetryService`, `TelemetrySnapshotView`) + `registerScopedService(LifecycleScope.App, …)`.
- `src/app/telemetry/consoleAppender.ts`: `ConsoleAppender` — echoes events to a log function (dev / debug).
- `src/app/telemetry/cloudAppender.ts`: `CloudAppender` — sanitizes + PII-cleans properties, batches + enriches + posts to the telemetry endpoint; maps the envelope `session_id` / `model` from the ambient context.
- `src/app/telemetry/cloudTransport.ts`: `CloudTransport` — HTTP transport behind `CloudAppender`.
- `src/app/telemetry/privacy.ts`: outbound PII redaction (`cleanTelemetryProperties`) — URLs, emails, tokens, and absolute file paths become `<REDACTED: ...>` labels; `node_modules/` tails are kept.

## Emitting events (business services)

Inject `ITelemetryService` and call `track2` with a registered event:

```ts
import { ITelemetryService } from '#/app/telemetry/telemetry';

constructor(@ITelemetryService private readonly telemetry: ITelemetryService) {}

this.telemetry.track2('cron_fired', { task_id: taskId, coalesced_count: 0, stale: false, buffered: false, recurring: true });
```

`track2` is checked against the registry in `events.ts` at compile time: the event name must be a key of `telemetryEventDefinitions`, and the properties must match the registered interface exactly (extra or missing keys are compile errors). **New events must be registered first** — add a properties interface, then register it with `defineAgentTelemetryEvent<P>({ owner, comment, properties })` when every emission path goes through an Agent-scoped `ITelemetryService` binding, or `defineTelemetryEvent<P>` otherwise (including events with any non-Agent emission path, e.g. `image_compress` from the kap-server prompt routes), documenting every property. For agent-scope events the registered interface is the business payload only: ambient `agent_id` is declared once in `AgentTelemetryEventContext`, so it must not appear in the payload or at call sites. Naming: snake_case for events and properties, unit suffixes (`_ms` / `_count` / `_bytes`), no user content or file paths; `test/app/telemetry/events.test.ts` enforces the conventions.

At emission the service builds a `TelemetryAppenderRecord` — `{ event, context, properties }` — and fans it out to every registered appender. `context` is the full merged ambient; `properties` is the ambient merged into the per-call payload (see below). A single throwing appender is isolated via `onUnexpectedError` and never blocks the rest.

### Ambient context (session / agent / turn)

Ambient context is layered to the scope topology (`context.ts`): the App root holds process-wide fields, `sessionLifecycle` and `agentLifecycle` bind Session/Agent fragments at materialization via `bindTelemetryScope` (disposed with the scope), and `loopService` / `profileService` / `planService` / `llmRequester` write the Turn/Agent fields at runtime (`turn_id`, `trace_id`, `thinking_effort`, `mode`, `provider_type`, `protocol`).

- `setContext(patch)` writes the **caller scope's shared fragment** — every subsequent event emitted in that scope carries the field with no call-site plumbing. Write `undefined` to clear a key (e.g. the loop clears `turn_id` in `finally` after `turn_ended`, so post-turn emissions carry no stale turn identity).
- `getContext()` reads the merged chain (nearest layer wins).
- `withContext(patch)` returns a **frozen full-chain snapshot** for point-in-time capture across async boundaries — the view is detached: later `setContext` writes in the scope are invisible to it, and `setContext` on the view mutates only the view's private copy. Use it when emitting on behalf of a scope you are not part of (HTTP routes, lookup helpers, session teardown):

```ts
telemetry.withContext({ session_id: sessionId }).track2('session_load_failed', { reason: 'not_found' });
```

At emission the full merged ambient flows into every event's properties **unconditionally** — `session_id` is remapped to the camelCase `sessionId` key, every other ambient field merges as-is, and per-call properties override ambient values on key collision. There is no registry-key filtering: a field written once via `setContext` reaches every subsequent event in that scope, which is why the lifecycle discipline above (write at start, clear at end) is the only correctness mechanism for time-varying fields.

## Appenders (destinations)

An appender is the destination an event is fanned out to. It is **not a DI Service** — it is a plain object implementing `ITelemetryAppender`, held by `TelemetryService`.

```ts
export interface ITelemetryAppender {
  track(record: TelemetryAppenderRecord): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}
```

Built-in appenders:

- `ConsoleAppender` — `[telemetry] <event> <json>` to a log function (default `console.log`); options `prefix` / `pretty` / `log`.
- `CloudAppender` — batches events, enriches with common context (`app_name` / `version` / `platform` / …), and posts to `https://telemetry-logs.kimi.com/v1/event` through `CloudTransport` (Bearer auth, retry, on-disk fallback). The envelope `session_id` / `model` are mapped from the record's ambient `context` (constructor values as fallback). Options: `homeDir` / `deviceId` / `sessionId?` / `appName` / `version` / `uiMode?` / `model?` / `getAccessToken?` / `endpoint?` / `flushThreshold?` / `flushIntervalMs?`.

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

`addAppender` returns an `IDisposable` that removes the appender when disposed. `removeAppender(appender)` drops one.

> There is no production bootstrap wired yet — `TelemetryService` defaults to `[nullTelemetryAppender]`, so `track2(...)` is a no-op until `addAppender` is called at startup.

## Lifecycle

- `setEnabled(false)` drops emissions (service-level switch); `setEnabled(true)` resumes. `flush` / `shutdown` are unaffected by the switch.
- `flush()` / `shutdown()` fan out to all appenders concurrently; a single rejecting appender is swallowed. Await `shutdown()` before process exit so buffered events (e.g. in `CloudAppender`) are sent.

## Red lines (this topic)

- Business services depend only on `ITelemetryService` — never import an appender class.
- Telemetry is layer-1 root: do not inject any business-domain service into it, and keep the facade at `App` scope (scope bindings are created by the lifecycle services, not by business code).
- Appenders are plain `ITelemetryAppender` objects, not DI Services — register them with `addAppender`, never via `registerScopedService`.
- `track2` is fire-and-forget and must not throw; appender `track` must be synchronous — buffer and send asynchronously via `flush` / `shutdown`.
- Await `telemetry.shutdown()` before process exit when a buffering appender is registered.
- Keep event names stable; register every business event in `events.ts` and emit via `track2` — properties must be JSON-serializable primitives (non-primitives are dropped with a warning by `CloudAppender`).
- Agent identity is ambient: agent-scope events go through `defineAgentTelemetryEvent` and get `agent_id` from the scoped telemetry binding — do not pass `agent_id` at business call sites (per-event identities such as `subagent_created` and the cron events are the exception).
- Time-varying ambient fields (`turn_id`, `trace_id`) must be written and cleared by their owner around the unit of work they identify — everything in the scope sees them, so a stale write pollutes every later event.
