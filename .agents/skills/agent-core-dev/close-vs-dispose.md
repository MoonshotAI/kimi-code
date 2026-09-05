# Topic — Close vs Dispose

How to shut down a scoped service in `agent-core-v2`: when `dispose()` is enough, when to add an async `close()`, and where cancellation / abort belongs. Read this before putting business shutdown logic into a `Disposable`.

## The one-sentence rule

> **`close()` is async business shutdown; `dispose()` is synchronous resource cleanup.**

`close()` finishes a domain's work: stop in-flight operations, apply shutdown policy, flush persistence, release async resources. `dispose()` releases object resources: event subscriptions, timers, hook registrations, and child disposables.

## Why they must stay separate

`IDisposable.dispose()` is synchronous:

```ts
export interface IDisposable {
  dispose(): void;
}
```

The container calls it during scope teardown. Disposal order is deterministic (orient.md): child scopes first, then reverse construction order within a scope. Nothing awaits a Promise returned from `dispose()`.

Business shutdown is usually async. It may need to:

- stop in-flight tasks and wait for settlement;
- decide policy (`kill` vs `keepAliveOnExit` vs `markLost`);
- flush write queues and persistence;
- emit final records / events / telemetry;
- close sockets, child processes, or external clients.

If that logic lives in `dispose()`, it becomes fire-and-forget: the scope keeps tearing down, dependencies may be disposed immediately afterward, and the async continuation can run against a half-dead object graph.

## What `close()` owns

Add `close(): Promise<void>` when a service owns async shutdown work:

```ts
export interface IXxxService {
  readonly _serviceBrand: undefined;
  close(reason?: string): Promise<void>;
}
```

A good `close()`:

- is idempotent — repeated calls return the same Promise or no-op;
- is called by lifecycle code **before** `scope.dispose()`;
- rejects new work after it starts;
- applies shutdown policy explicitly;
- awaits the work it starts;
- leaves `dispose()` with only synchronous cleanup.

Sketch:

```ts
class XxxService extends Disposable implements IXxxService {
  declare readonly _serviceBrand: undefined;
  private closed = false;

  async close(reason = 'scope closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.stopInFlightWork(reason);
    await this.flushPersistence();
  }

  override dispose(): void {
    this.closed = true;
    // synchronous cleanup only: clear timers, remove listeners, release handles.
    super.dispose();
  }
}
```

`flush()` is different from `close()`: `flush()` persists buffered state while the service stays open; `close()` is terminal.

## What `dispose()` owns

`dispose()` releases resources owned by the object instance:

```ts
class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IEventService event: IEventService) {
    super();
    this._register(event.subscribe(() => { /* … */ }));
  }
}
```

Use `dispose()` to:

- `_register(...)` event subscriptions and hook registrations;
- clear timers;
- remove signal listeners;
- dispose child `IDisposable`s;
- detach from synchronous handles.

`dispose()` must be idempotent and should avoid throwing. If `close()` was already called, `dispose()` should be a no-op for business work and only clean resources.

## Where abort / cancellation belongs

Cancellation is not the same thing as graceful shutdown.

For an operation-scoped object, a cancellation trigger can be disposed:

```ts
const tokenSource = new CancellationTokenSource();
store.add(toDisposable(() => tokenSource.cancel()));
```

This is fine when the contract is **fire-and-forget cancel**: the operation observes the token and settles asynchronously; disposal does not wait for completion.

For a manager/service that owns many tasks and their state, do not use `dispose()` as the graceful abort path. Expose `stop()` / `stopAll()` / `close()` and let lifecycle code await the one it needs.

Background-specific rule: a `background`-style service may use `AbortController` internally to propagate cancellation to process / agent / question tasks, but manager shutdown belongs in `close()` or explicit `stopAll()`. `dispose()` may best-effort abort controllers only as a safety net; it must not be the mechanism that decides terminal status, persistence, or notifications.

## Decision tree

```text
What does the service own?
  │
  ├─ only event subscriptions / timers / disposable handles?
  │     └─ extend Disposable; no close() needed.
  │
  ├─ async work, in-flight tasks, persistence buffers, sockets, child processes?
  │     └─ add close(): Promise<void>; call it before scope.dispose().
  │
  ├─ a single operation that callers may cancel?
  │     └─ expose an AbortSignal / CancellationToken or a fire-and-forget cancel handle.
  │
  └─ both async shutdown and disposable resources?
        └─ close() for business shutdown; dispose() for resource cleanup.
```

## VSCode parallel

VSCode uses the same split:

- `src/vs/base/common/lifecycle.ts` — `IDisposable.dispose(): void` for synchronous cleanup.
- `src/vs/base/parts/storage/common/storage.ts` — `close(): Promise<void>` flushes and closes the database.
- `src/vs/base/common/cancellation.ts` — `CancellationTokenSource.dispose(true)` / `cancelOnDispose()` cancels operation-scoped work without awaiting it.

The lesson is not "never cancel in dispose". It is: **disposal may trigger cancellation for a scoped operation, but service shutdown policy stays in an explicit async close path.**

## Red lines (this topic)

- Do not put business shutdown in `dispose()` — `dispose()` is synchronous and is not awaited.
- Do not `await` inside `dispose()`.
- Do not rely on `dispose()` to flush persistence, emit final events, wait for tasks, or send notifications.
- Add `close(): Promise<void>` for async shutdown and call it before `scope.dispose()`.
- Keep `close()` and `dispose()` idempotent; `dispose()` after `close()` must be safe.
- Use disposal as a cancellation trigger only for operation-scoped work, not as a manager/service shutdown policy.
