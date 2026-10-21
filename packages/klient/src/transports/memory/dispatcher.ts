import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import type { IAgentScopeHandle } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { getOrRestoreAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/getOrRestoreAgent';
import { agentContextOf } from '@moonshot-ai/agent-core-v2/agent/scopeContext/scopeContext';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  type Interaction,
  type InteractionKind,
  type InteractionRequest,
} from '@moonshot-ai/agent-core-v2/human/interaction/interaction';
import { interactions } from '@moonshot-ai/agent-core-v2/human/interaction/facade';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import type { SkillActivationOrigin } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import { ITelemetryService } from '@moonshot-ai/agent-core-v2/app/telemetry/telemetry';
import type {
  PromptWithSkillsInput,
  SkillActivationInput,
} from '@moonshot-ai/agent-core-v2/features/skill/skill';
import { IAgentSkillService } from '@moonshot-ai/agent-core-v2/features/skill/skillService';
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

export interface ScopeLike {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
}

export function wireClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function pendingInteractionsOfSession(sessionId: string): readonly Interaction[] {
  return interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
  });
}

function pendingIdsOfSession(sessionId: string): readonly string[] {
  return pendingInteractionsOfSession(sessionId).map((i) => i.id);
}

function respondScoped(sessionId: string, id: string, response: unknown): boolean {
  if (
    interactions.findOne({
      id,
      resolved: false,
      tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
    }) === undefined
  ) {
    return false;
  }
  return interactions.respond(id, response);
}

function withSessionTags<TPayload>(
  sessionId: string,
  req: InteractionRequest<TPayload>,
): InteractionRequest<TPayload> {
  return {
    ...req,
    tags: {
      ...req.tags,
      [INTERACTION_TAG_AGENT_ID]: req.tags?.[INTERACTION_TAG_AGENT_ID] ?? MAIN_AGENT_ID,
      [INTERACTION_TAG_SESSION_ID]: sessionId,
    },
  };
}

function interactionServiceView(sessionId: string): Record<string, unknown> {
  return {
    request: (req: InteractionRequest<unknown>) =>
      interactions.request(withSessionTags(sessionId, req)),
    enqueue: (req: InteractionRequest<unknown>) =>
      interactions.enqueue(withSessionTags(sessionId, req)),
    respond: (id: string, response: unknown) => {
      respondScoped(sessionId, id, response);
    },
    listPending: (kind?: InteractionKind) =>
      interactions.findAll({
        kind,
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
      }),
    isRecentlyResolved: (id: string) =>
      interactions.findOne({
        id,
        resolved: true,
        tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
      }) !== undefined,
    onDidChangePending: (listener: (event: unknown) => void) =>
      interactions.onDidChangePending(listener),
    onDidResolve: (listener: (event: unknown) => void) =>
      interactions.onDidResolve(listener),
  };
}

function approvalServiceView(sessionId: string): Record<string, unknown> {
  return {
    listPending: () =>
      pendingInteractionsOfSession(sessionId)
        .filter((i) => i.kind === 'approval')
        .map((i) => ({ ...(i.payload as Record<string, unknown>), id: i.id })),
    decide: (id: string, response: unknown) => {
      respondScoped(sessionId, id, response);
    },
  };
}

function questionServiceView(sessionId: string): Record<string, unknown> {
  return {
    listPending: () =>
      pendingInteractionsOfSession(sessionId)
        .filter((i) => i.kind === 'question')
        .map((i) => ({ ...(i.payload as Record<string, unknown>), id: i.id })),
    answer: (id: string, result: unknown) => {
      respondScoped(sessionId, id, result);
    },
    dismiss: (id: string) => {
      respondScoped(sessionId, id, null);
    },
  };
}

function agentSkillServiceView(agent: IAgentScopeHandle): Record<string, unknown> {
  const skill = agent.accessor.get(IAgentSkillService);
  return {
    activate: (input: SkillActivationInput) => skill.activate(input),
    promptWithSkills: (input: PromptWithSkillsInput) => skill.promptWithSkills(input),
    recordModelToolActivation: (origin: SkillActivationOrigin) => {
      skill.recordModelToolActivation(origin);
    },
  };
}

function agentLoopServiceView(agent: IAgentScopeHandle): Record<string, unknown> {
  const loop = agent.accessor.get(IAgentLoopService);
  return {
    cancelFromUser: (turnId?: number) => {
      const snapshot = loop.snapshot();
      if (snapshot.state === 'running') {
        agent.accessor.get(ITelemetryService).track2('cancel', {
          from: 'streaming',
          trace_id: snapshot.activeTraceId,
        });
      }
      loop.cancel(turnId === undefined ? undefined : { turnId });
    },
  };
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
const MCP_SERVER_NOT_FOUND = 40408;
const MCP_OAUTH_FAILED = 40929;
const PROMPT_ID_CONFLICT = 40927;

const MCP_MANAGEMENT_SERVICE = 'mcpManagementService';

const AGENT_CONTEXT_SERVICES: ReadonlySet<string> = new Set([
  'agentTokenCountingService',
  'agentUsageService',
]);

function rethrowFileErrorAsRpc(error: unknown): never {
  if (error instanceof Error2 && error.code === FileErrors.codes.FILE_NOT_FOUND) {
    throw new RPCError(NOT_FOUND, error.message, error.details);
  }
  throw error;
}

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
  readonly sessionId?: string;
}

type FileServiceWireTarget = {
  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;
  get(fileId: string): Promise<GetResult>;
};

export function createMemoryDispatcher(root: ScopeLike): MemoryDispatcher {
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
    if (scope.agentId === undefined) {
      return { kind: 'session', like: session, sessionId: scope.sessionId };
    }
    if (scope.agentId === 'main') {
      const context = await ensureMainAgent(session);
      const handle = session.accessor.get(IAgentLifecycleService).handleOf(context.agentId);
      if (handle === undefined) {
        throw new RPCError(NOT_FOUND, 'main agent was not found');
      }
      return { kind: 'agent', like: handle };
    }
    const agent = await getOrRestoreAgent(session, scope.agentId);
    if (agent === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    return { kind: 'agent', like: agent };
  }

  function sessionInteractionView(
    resolved: ResolvedScope,
    service: string,
  ): Record<string, unknown> | undefined {
    if (resolved.kind !== 'session') return undefined;
    const sessionId = resolved.sessionId as string;
    if (service === 'sessionInteractionService') return interactionServiceView(sessionId);
    if (service === 'sessionApprovalService') return approvalServiceView(sessionId);
    if (service === 'sessionQuestionService') return questionServiceView(sessionId);
    return undefined;
  }

  function resolveService(resolved: ResolvedScope, service: string): Record<string, unknown> {
    if (
      service === 'sessionInteractionService' ||
      service === 'sessionApprovalService' ||
      service === 'sessionQuestionService'
    ) {
      const view = sessionInteractionView(resolved, service);
      if (view === undefined) {
        throw new RPCError(REQUEST_INVALID, `service not available in ${resolved.kind} scope: ${service}`);
      }
      return view;
    }
    if (service === 'agentSkillService') {
      if (resolved.kind !== 'agent') {
        throw new RPCError(REQUEST_INVALID, `service not available in ${resolved.kind} scope: ${service}`);
      }
      return agentSkillServiceView(resolved.like as IAgentScopeHandle);
    }
    if (service === 'agentLoopService') {
      if (resolved.kind !== 'agent') {
        throw new RPCError(REQUEST_INVALID, `service not available in ${resolved.kind} scope: ${service}`);
      }
      return agentLoopServiceView(resolved.like as IAgentScopeHandle);
    }
    const token = serviceTokens[service];
    if (token === undefined) {
      throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
    }
    return resolved.like.accessor.get(token) as Record<string, unknown>;
  }

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
      const sessionId = resolved.sessionId as string;
      let last = pendingIdsOfSession(sessionId).join('');
      return {
        dispose: interactions.onDidChangePending(() => {
          const next = pendingIdsOfSession(sessionId).join('');
          if (next === last) return;
          last = next;
          handler(wireClone(pendingInteractionsOfSession(sessionId)));
        }),
      };
    }
    if (resolved.kind === 'session' && name === 'interactions:resolved') {
      const sessionId = resolved.sessionId as string;
      const known = new Set(pendingIdsOfSession(sessionId));
      const detachChange = interactions.onDidChangePending(() => {
        for (const id of pendingIdsOfSession(sessionId)) known.add(id);
      });
      const detachResolve = interactions.onDidResolve((resolution) => {
        if (!known.delete(resolution.id)) return;
        handler(wireClone(resolution));
      });
      return {
        dispose: () => {
          detachChange();
          detachResolve();
        },
      };
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
        if (service === 'modelsDevImport' && error instanceof Error2) {
          throw new RPCError(REQUEST_INVALID, error.message, error.details);
        }
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
                const iterable = (
                  catalog as {
                    generate(
                      id: string,
                      input: unknown,
                      signal: AbortSignal,
                      params: unknown,
                    ): AsyncIterable<unknown>;
                  }
                ).generate(
                  modelId as string,
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
