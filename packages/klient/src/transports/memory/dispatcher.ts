/**
 * In-process dispatcher — resolves a wire triple `(service, method, args)`
 * against a live engine scope and mirrors kap-server's dispatcher semantics
 * (reflection call, non-function members are property reads, `main` agent
 * auto-materialized via `ensureMainAgent`). Scope routing resolves workspace
 * instances through `IWorkspaceInstanceManager` and live sessions through the
 * App `SessionManager`, matching the server's `resolveScope`. Every argument,
 * result, and event payload passes
 * through `wireClone` (a JSON round-trip), so consumers observe
 * byte-identical data no matter whether the call crossed a socket or stayed
 * in-process — and non-serializable leaks fail early.
 *
 * Shared by the memory transport and the IPC host, which guarantees ipc and
 * memory behave identically by construction.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import type { IAgentScopeHandle } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { agentContextOf } from '@moonshot-ai/agent-core-v2/agent/scopeContext/scopeContext';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import type {
  FileMeta,
  GetResult,
  SaveOptions,
} from '@moonshot-ai/agent-core-v2/app/file/fileService';
import { FileErrors } from '@moonshot-ai/agent-core-v2/app/file/fileService';
import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';

import { Readable } from 'node:stream';

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { IEventService, serviceTokens } from './serviceRegistry.js';

/** Structural minimum of an engine `Scope` / `IScopeHandle`. */
export interface ScopeLike {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
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
/** kap-server wire codes mirrored so memory/ipc surface the same numeric codes as `/api/v2/mcp`. */
const MCP_SERVER_NOT_FOUND = 40408;
const MCP_OAUTH_FAILED = 40929;
const PROMPT_ID_CONFLICT = 40927;

/** Wire name of the engine's `IMcpManagementService` decorator id. */
const MCP_MANAGEMENT_SERVICE = 'mcpManagementService';

/**
 * Session-scope domain services whose methods take the lifecycle-issued
 * `AgentContext` as their first argument. The wire stays agentId-only (the
 * scope ref already carries it), so the live context is resolved here at the
 * edge — after `wireClone`, since the context is a live object that must
 * never cross the JSON round-trip.
 */
const AGENT_CONTEXT_SERVICES: ReadonlySet<string> = new Set([
  'agentTokenCountingService',
  'agentUsageService',
]);

/**
 * Engine file errors cross the facade as public `RPCError`s, never as the
 * engine's raw `Error2`. The dispatcher is shared by both transports, so
 * memory and ipc then surface the identical `NOT_FOUND` code for a stale or
 * expired upload id.
 */
function rethrowFileErrorAsRpc(error: unknown): never {
  if (error instanceof Error2 && error.code === FileErrors.codes.FILE_NOT_FOUND) {
    throw new RPCError(NOT_FOUND, error.message, error.details);
  }
  throw error;
}

/**
 * Same treatment for the MCP management plane: its coded rejections cross as
 * `RPCError`s carrying the kap-server wire codes, so memory and ipc behave
 * identically (a raw `Error2` would cross ipc as a generic 50001) and both
 * match `/api/v2/mcp` — `mcp.server_not_found` → 40408, `request.invalid` /
 * `config.invalid` → 40001, `mcp.oauth_failed` → 40929.
 */
function rethrowMcpManagementErrorAsRpc(error: unknown): never {
  if (error instanceof Error2) {
    switch (error.code) {
      case ErrorCodes.MCP_SERVER_NOT_FOUND:
        throw new RPCError(MCP_SERVER_NOT_FOUND, error.message, error.details);
      case ErrorCodes.REQUEST_INVALID:
      case ErrorCodes.CONFIG_INVALID:
        throw new RPCError(REQUEST_INVALID, error.message, error.details);
      case ErrorCodes.MCP_OAUTH_FAILED:
        throw new RPCError(MCP_OAUTH_FAILED, error.message, error.details);
    }
  }
  throw error;
}

type ScopeKind = 'core' | 'workspace' | 'session' | 'agent';

interface ResolvedScope {
  readonly kind: ScopeKind;
  readonly like: ScopeLike;
}

/** Structural view of the engine's `IFileService` used by the wire adaptation. */
type FileServiceWireTarget = {
  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;
  get(fileId: string): Promise<GetResult>;
};

export function createMemoryDispatcher(root: ScopeLike): MemoryDispatcher {
  /** Mirrors kap-server's `resolveScope`, incl. main-agent materialization. */
  async function resolveScope(scope: ScopeRef): Promise<ResolvedScope> {
    if (scope.workspaceId !== undefined) {
      const workspace = await root.accessor
        .get(IWorkspaceInstanceManager)
        .getOrCreate({ workspaceId: scope.workspaceId });
      void workspace.program;
      return { kind: 'workspace', like: root };
    }
    if (scope.sessionId === undefined) return { kind: 'core', like: root };
    const session = root.accessor.get(ISessionManager).get(scope.sessionId) ?? getLiveSessionById(root.accessor, scope.sessionId);
    if (session === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
    }
    if (scope.agentId === undefined) return { kind: 'session', like: session };
    if (scope.agentId === 'main') {
      return { kind: 'agent', like: await ensureMainAgent(session) };
    }
    const agent = session.accessor.get(IAgentLifecycleService).findAgentHandle(scope.agentId);
    if (agent === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    return { kind: 'agent', like: agent };
  }

  function resolveService(resolved: ResolvedScope, service: string): Record<string, unknown> {
    const token = serviceTokens[service];
    if (token === undefined) {
      throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
    }
    return resolved.like.accessor.get(token) as Record<string, unknown>;
  }

  /** Mirrors kap-server's WS `eventMap` per scope kind. */
  function subscribeStream(
    resolved: ResolvedScope,
    name: string,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (resolved.kind === 'core' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventService);
      return bus.subscribe((event) => {
        handler(wireClone(event));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidChangePending(() => {
        handler(wireClone(interaction.listPending()));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions:resolved') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidResolve((resolution) => {
        handler(wireClone(resolution));
      });
    }
    if (resolved.kind === 'agent' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventBus);
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
      // `fileService` adapts bytes ⇄ streams: the JSON wire cannot carry
      // `save`'s Readable source or `get`'s result stream, so both cross as
      // base64 strings (the same kind of wire adaptation as
      // `modelResolver.generate` in `stream`).
      if (service === 'fileService' && method === 'save') {
        const [data, filename, options] = args as [string, string, SaveOptions | undefined];
        const files = instance as FileServiceWireTarget;
        try {
          const meta = await files.save(
            Readable.from(Buffer.from(data, 'base64')),
            filename,
            options,
          );
          return wireClone(meta);
        } catch (error) {
          rethrowFileErrorAsRpc(error);
        }
      }
      if (service === 'fileService' && method === 'get') {
        const [fileId] = args as [string];
        const files = instance as FileServiceWireTarget;
        try {
          const { meta, stream } = await files.get(fileId);
          const chunks: Buffer[] = [];
          for await (const chunk of stream()) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          return { meta: wireClone(meta), data: Buffer.concat(chunks).toString('base64') };
        } catch (error) {
          rethrowFileErrorAsRpc(error);
        }
      }
      const member = instance[method];
      if (member === undefined) {
        throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
      }
      if (typeof member !== 'function') {
        return wireClone(member);
      }
      const clonedArgs = args.map(wireClone);
      const callArgs = AGENT_CONTEXT_SERVICES.has(service)
        ? [agentContextOf(resolved.like as IAgentScopeHandle), ...clonedArgs]
        : clonedArgs;
      try {
        const result = await (member as (...a: unknown[]) => unknown).apply(instance, callArgs);
        return wireClone(result);
      } catch (error) {
        if (service === MCP_MANAGEMENT_SERVICE) {
          rethrowMcpManagementErrorAsRpc(error);
        }
        if (error instanceof Error2 && error.code === ErrorCodes.PROMPT_ID_CONFLICT) {
          throw new RPCError(PROMPT_ID_CONFLICT, error.message, error.details);
        }
        throw error;
      }
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
