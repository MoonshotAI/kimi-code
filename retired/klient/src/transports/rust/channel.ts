/**
 * The rust transport channel — a `KlientChannel` over the Rust engine.
 *
 * `call` dispatches `(service, method)` through the registered service
 * tables (`./router.ts`). `listen` wires engine `host/event` payloads
 * (installed once via `installSessionHostHandlers`) to scope-matched
 * subscriptions: core listeners see every event, session listeners only
 * their session's (with `btw-<sid>` side-question turns mapped back onto the
 * parent session, matching the node-sdk convention), agent listeners the
 * session's main-agent surface. `stream` delegates to streaming service
 * methods (only `modelResolver.generate` today) and wire-clones each chunk.
 */

import type { EventSourceRef, IDisposable, KlientChannel, ScopeRef } from '../../core/channel.js';
import type * as RustLoop from '@moonshot-ai/kimi-agent/rust-loop';
import { dispatchCall } from './router.js';
import type { RustHostServices } from './types.js';

/** JSON round-trip so in-process data matches wire data exactly (same as the
 *  v2 dispatcher's `wireClone`). */
export function wireClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Subscription {
  readonly scope: ScopeRef;
  readonly source: EventSourceRef;
  readonly handler: (data: unknown) => void;
  readonly onError?: (error: Error) => void;
}

interface RustChannelOptions {
  readonly rust: typeof RustLoop;
  readonly host: RustHostServices;
}

export class RustChannel implements KlientChannel {
  private readonly rust: typeof RustLoop;
  private readonly host: RustHostServices;
  private readonly subscriptions = new Set<Subscription>();
  private closed = false;

  constructor(options: RustChannelOptions) {
    this.rust = options.rust;
    this.host = options.host;
    this.rust.installSessionHostHandlers({
      // klient sessions run host-proxy turns only when a session service
      // prompts; the llm/tool callbacks are wiring stubs until S1 lands.
      llmChat: async () => {
        throw new Error('no llm step configured for klient rust transport');
      },
      toolExecute: async () => {
        throw new Error('no tool execute handler configured for klient rust transport');
      },
      onEvent: (raw) => this.routeEngineEvent(raw),
    });
  }

  async call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new Error('channel is closed');
    const result = await dispatchCall(service, method, { scope, args, rust: this.rust, host: this.host });
    return wireClone(result);
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    if (this.closed) throw new Error('channel is closed');
    const source = dispatchCall(service, method, { scope, args, rust: this.rust, host: this.host });
    return {
      [Symbol.asyncIterator]() {
        let iterator: AsyncIterator<unknown> | undefined;
        let started: Promise<void> | undefined;
        const ensureStarted = (): Promise<void> => {
          started ??= (async () => {
            const iterable = (await source) as AsyncIterable<unknown>;
            iterator = iterable[Symbol.asyncIterator]();
          })();
          return started;
        };
        return {
          async next() {
            await ensureStarted();
            const result = await iterator!.next();
            if (result.done) return { done: true as const, value: undefined };
            return { done: false, value: wireClone(result.value) };
          },
          async return(value?: unknown) {
            await iterator?.return?.(value);
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    if (source.kind === 'emitter') {
      // Host-side `onDid*` emitters (kosong.providers.changed / models.changed
      // / config.changed): the Rust engine hosts no such emitters, so emitter
      // subscriptions are wired to the local host event bus instead. Without
      // a bus there is nothing to attach — report the failure at attach time.
      const bus = this.host.events;
      if (bus === undefined) {
        queueMicrotask(() =>
          onError?.(new Error(`no local event bus for emitter ${source.event}`)),
        );
        return { dispose: () => {} };
      }
      return bus.on(source.event, (payload) => {
        try {
          handler(wireClone(payload));
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    const subscription: Subscription = { scope, source, handler, onError };
    this.subscriptions.add(subscription);
    return {
      dispose: () => {
        this.subscriptions.delete(subscription);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
  }

  /** Route an engine `host/event` payload to scope-matched subscriptions. */
  private routeEngineEvent(raw: unknown): void {
    const event = (raw ?? {}) as { type?: string; session_id?: string | null };
    const rawSessionId = event.session_id ?? '';
    // Side-question (btw) turns carry the engine's `btw-<sid>` session id;
    // they belong to the parent session (node-sdk convention).
    const sessionId = rawSessionId.startsWith('btw-')
      ? rawSessionId.slice('btw-'.length)
      : rawSessionId;
    for (const sub of this.subscriptions) {
      if (this.matches(sub, sessionId)) {
        try {
          sub.handler(wireClone(event));
        } catch (error) {
          sub.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  private matches(sub: Subscription, eventSessionId: string): boolean {
    const { scope, source } = sub;
    // Emitter-kind subscriptions never reach here — `listen` routes them to
    // the local host event bus (see above); the guard only narrows the
    // EventSourceRef union for TypeScript. Stream subscriptions (`events` /
    // `interactions` / `interactions:resolved`) are routed by scope session id.
    if (source.kind === 'emitter') return false;
    if (scope.sessionId === undefined) {
      return source.name === 'events';
    }
    if (eventSessionId.length === 0 || eventSessionId !== scope.sessionId) {
      return false;
    }
    return source.name === 'events' || source.name === 'interactions' || source.name === 'interactions:resolved';
  }
}
