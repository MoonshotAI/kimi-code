/**
 * In-process dispatcher — resolves a wire triple `(service, method, args)`
 * against a live engine scope and mirrors kap-server's dispatcher semantics
 * (reflection call, non-function members are property reads, `main` agent
 * auto-materialized via the host-supplied `ensureMainAgent`). Scope routing
 * walks `ISessionLifecycleService` / `IAgentLifecycleService` exactly like
 * the server's `resolveScope`. Every argument, result, and event payload
 * passes through `wireClone` (a JSON round-trip), so consumers observe
 * byte-identical data no matter whether the call crossed a socket or stayed
 * in-process — and non-serializable leaks fail early.
 *
 * The engine is never imported here: the host hands the DI token map and
 * the `main`-agent materializer in via `MemoryEngineAccess` (see
 * `engine.ts`), keeping klient independent of the retired
 * `@moonshot-ai/agent-core-v2` package.
 *
 * Shared by the memory transport and the IPC host, which guarantees ipc and
 * memory behave identically by construction.
 */

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import {
  type EngineToken,
  type MemoryEngineAccess,
  type ScopeLike,
} from './engine.js';

export type { ScopeLike } from './engine.js';

/** Structural minimum of the engine `ISessionLifecycleService`. */
interface SessionLifecycleLike {
  get(id: string): ScopeLike | undefined;
}

/** Structural minimum of the engine `IAgentLifecycleService`. */
interface AgentLifecycleLike {
  get(id: string): ScopeLike | undefined;
  create(opts: { agentId: string }): Promise<ScopeLike>;
}

/** Structural minimum of the engine `IEventService` / `IEventBus` bus. */
interface EventBusLike {
  subscribe(listener: (event: unknown) => void): IDisposable;
}

/** Structural minimum of the engine `ISessionInteractionService`. */
interface SessionInteractionLike {
  onDidChangePending(listener: () => void): IDisposable;
  listPending(): unknown[];
  onDidResolve(listener: (resolution: unknown) => void): IDisposable;
}

/** JSON round-trip so in-process data matches wire data exactly. */
export function wireClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface MemoryDispatcher {
  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown>;
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable;
}

const REQUEST_INVALID = 40001;
const NOT_FOUND = 40404;

type ScopeKind = 'core' | 'session' | 'agent';

interface ResolvedScope {
  readonly kind: ScopeKind;
  readonly like: ScopeLike;
}

function getService(like: ScopeLike, token: EngineToken): unknown {
  return like.accessor.get(token);
}

export function createMemoryDispatcher(
  root: ScopeLike,
  engine: MemoryEngineAccess,
): MemoryDispatcher {
  /** Mirrors kap-server's `resolveScope`, incl. main-agent materialization. */
  async function resolveScope(scope: ScopeRef): Promise<ResolvedScope> {
    if (scope.sessionId === undefined) return { kind: 'core', like: root };
    const lifecycle = getService(root, engine.sessionLifecycleServiceToken) as SessionLifecycleLike;
    const session = lifecycle.get(scope.sessionId);
    if (session === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
    }
    if (scope.agentId === undefined) return { kind: 'session', like: session };
    if (scope.agentId === 'main') {
      return { kind: 'agent', like: await engine.ensureMainAgent(session) };
    }
    const agentLifecycle = getService(session, engine.agentLifecycleServiceToken) as AgentLifecycleLike;
    const agent = agentLifecycle.get(scope.agentId);
    if (agent === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    return { kind: 'agent', like: agent };
  }

  function resolveService(resolved: ResolvedScope, service: string): Record<string, unknown> {
    const token = engine.serviceTokens[service];
    if (token === undefined) {
      throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
    }
    return getService(resolved.like, token) as Record<string, unknown>;
  }

  /** Mirrors kap-server's WS `eventMap` per scope kind. */
  function subscribeStream(
    resolved: ResolvedScope,
    name: string,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (resolved.kind === 'core' && name === 'events') {
      const bus = getService(resolved.like, engine.eventServiceToken) as EventBusLike;
      return bus.subscribe((event) => {
        handler(wireClone(event));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions') {
      const interaction = getService(
        resolved.like,
        engine.sessionInteractionServiceToken,
      ) as SessionInteractionLike;
      return interaction.onDidChangePending(() => {
        handler(wireClone(interaction.listPending()));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions:resolved') {
      const interaction = getService(
        resolved.like,
        engine.sessionInteractionServiceToken,
      ) as SessionInteractionLike;
      return interaction.onDidResolve((resolution) => {
        handler(wireClone(resolution));
      });
    }
    if (resolved.kind === 'agent' && name === 'events') {
      const bus = getService(resolved.like, engine.eventBusToken) as EventBusLike;
      return bus.subscribe((event) => {
        handler(wireClone(event));
      });
    }
    throw new RPCError(REQUEST_INVALID, `unknown event stream: ${name} (${resolved.kind})`);
  }

  function subscribeSource(
    resolved: ResolvedScope,
    source: EventSourceRef,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (source.kind === 'stream') {
      return subscribeStream(resolved, source.name, handler);
    }
    if (!/^on[A-Z]/.test(source.event)) {
      throw new RPCError(REQUEST_INVALID, `not an event property: ${source.event}`);
    }
    const instance = resolveService(resolved, source.service);
    const emitter = instance[source.event];
    if (typeof emitter !== 'function') {
      throw new RPCError(REQUEST_INVALID, `event not found: ${source.service}.${source.event}`);
    }
    return (emitter as (listener: (data: unknown) => void) => IDisposable).call(
      instance,
      (data) => {
        handler(wireClone(data));
      },
    );
  }

  return {
    async call(scope, service, method, args) {
      const resolved = await resolveScope(scope);
      const instance = resolveService(resolved, service);
      const member = instance[method];
      if (member === undefined) {
        throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
      }
      if (typeof member !== 'function') {
        return wireClone(member);
      }
      const clonedArgs = args.map(wireClone);
      const result = await (member as (...a: unknown[]) => unknown).apply(instance, clonedArgs);
      return wireClone(result);
    },

    stream(scope, service, method, args): AsyncIterable<unknown> {
      // Special case: modelResolver.generate routes to
      // getRequester(modelId).request(input, signal, params) because the
      // catalog has no `generate` method — the facade synthesises the call.
      if (service === 'modelResolver' && method === 'generate') {
        return {
          [Symbol.asyncIterator]() {
            let source: AsyncIterator<unknown> | undefined;
            let started: Promise<void> | undefined;
            const controller = new AbortController();

            const ensureStarted = (): Promise<void> => {
              started ??= (async () => {
                const resolved = await resolveScope(scope);
                const catalog = resolveService(resolved, 'modelResolver');
                const [modelId, input, params] = args;
                const requester = (catalog as { getRequester(id: string): { request(...a: unknown[]): AsyncIterable<unknown> } })
                  .getRequester(modelId as string);
                const iterable = requester.request(
                  wireClone(input),
                  controller.signal,
                  wireClone(params),
                );
                source = iterable[Symbol.asyncIterator]();
              })();
              return started;
            };

            return {
              async next() {
                await ensureStarted();
                const result = await source!.next();
                if (result.done) return { done: true, value: undefined };
                return { done: false, value: wireClone(result.value) };
              },
              async return(value?: unknown) {
                controller.abort();
                await source?.return?.(value);
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }

      // The underlying service method returns an AsyncIterable; we wire-clone
      // each yielded chunk so in-process consumers observe the same data as
      // networked ones.
      return {
        [Symbol.asyncIterator]() {
          let source: AsyncIterator<unknown> | undefined;
          let started: Promise<void> | undefined;

          const ensureStarted = (): Promise<void> => {
            started ??= (async () => {
              const resolved = await resolveScope(scope);
              const instance = resolveService(resolved, service);
              const member = instance[method];
              if (member === undefined) {
                throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
              }
              if (typeof member !== 'function') {
                throw new RPCError(REQUEST_INVALID, `not a streaming method: ${service}.${method}`);
              }
              const clonedArgs = args.map(wireClone);
              const iterable = (member as (...a: unknown[]) => unknown).apply(
                instance,
                clonedArgs,
              ) as AsyncIterable<unknown>;
              source = iterable[Symbol.asyncIterator]();
            })();
            return started;
          };

          return {
            async next() {
              await ensureStarted();
              const result = await source!.next();
              if (result.done) return { done: true, value: undefined };
              return { done: false, value: wireClone(result.value) };
            },
            async return(value?: unknown) {
              await source?.return?.(value);
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },

    listen(scope, source, handler, onError) {
      // Scope resolution can be async (main-agent materialization); the
      // subscription attaches once settled. Disposing early cancels it.
      let inner: IDisposable | undefined;
      let disposed = false;
      void resolveScope(scope).then(
        (resolved) => {
          if (disposed) return;
          try {
            inner = subscribeSource(resolved, source, handler);
          } catch (error) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (error: unknown) => {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        },
      );
      return {
        dispose: () => {
          disposed = true;
          inner?.dispose();
        },
      };
    },
  };
}
