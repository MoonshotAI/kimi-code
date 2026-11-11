import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentReminderService,
  IAgentToolExecutorService,
  IAgentToolRegistryService,
  IAgentToolSelectService,
  IEventBus,
  ISessionMcpHandle,
  MAIN_AGENT_ID,
  SubagentSpawned,
  type AgentContext,
  type AgentMeta,
  type ContextInjectionContext,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { ISessionEphemeralMcpServers } from '@moonshot-ai/agent-core-v2/session/mcp/ephemeralMcpServers';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { legacyDidExecuteContext, legacyRejectedResult } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/legacyHooks';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';

export interface HostDisposable {
  dispose(): void;
}

export interface HostAgentMeta {
  readonly type?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface HostTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface HostThinkPart {
  readonly type: 'think';
  readonly think: string;
  readonly encrypted?: string;
  readonly detailsIndex?: number;
  readonly hidden?: boolean;
  readonly reasoningKey?: string;
}

export interface HostMediaPart {
  readonly type: 'image_url' | 'audio_url' | 'video_url';
  readonly imageUrl?: { readonly url: string; readonly id?: string; readonly name?: string };
  readonly audioUrl?: { readonly url: string; readonly id?: string };
  readonly videoUrl?: { readonly url: string; readonly id?: string; readonly name?: string };
}

export type HostContentPart = HostTextPart | HostThinkPart | HostMediaPart;

export interface HostToolDescription {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface HostToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
}

export interface HostContextMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: readonly HostContentPart[];
  readonly toolCalls?: readonly HostToolCall[];
  readonly toolCallId?: string;
  readonly tools?: readonly HostToolDescription[];
}

export interface HostMcpServerState {
  readonly status: string;
  readonly toolCount: number;
}

export interface HostSession {
  readonly id: string;
  agents(): Promise<Readonly<Record<string, HostAgentMeta>>>;
  readAgentHistory(agentId: string): Promise<readonly HostContextMessage[]>;
  mcpServer(name: string): HostMcpServerState | undefined;
  reconnectMcpServer(name: string): Promise<void>;
}

export interface HostSessions {
  list(): readonly HostSession[];
  get(sessionId: string): HostSession | undefined;
}

export interface HostReminderContext<D = unknown> {
  readonly lastInjection?: unknown;
  readonly lastDisclosure?: D;
  readonly isNewTurn: boolean;
  readonly signal?: AbortSignal;
}

export interface HostReminderResult<D = unknown> {
  readonly content: string;
  readonly disclosure?: D;
}

export type HostReminderProvider<D = unknown> = (
  context: HostReminderContext<D>,
) => string | HostReminderResult<D> | undefined | Promise<string | HostReminderResult<D> | undefined>;

export interface HostAgentState {
  readonly running: boolean;
  readonly turnId?: number;
  readonly profile?: string;
}

export interface HostToolResult {
  readonly output: string;
  readonly isError?: boolean;
}

export interface HostToolDidExecuteContext {
  readonly toolName: string;
  readonly outcome: string;
  readonly output: unknown;
}

export interface HostToolDecoratorContext {
  readonly turnId: number;
}

export interface HostAgent {
  readonly sessionId: string;
  readonly id: string;
  readonly generation: number;
  readonly meta?: HostAgentMeta;
  state(): HostAgentState;
  loadsToolsOnDemand(): boolean;
  registerReminder<D>(variant: string, provider: HostReminderProvider<D>): HostDisposable;
  onDidExecuteTool(
    listener: (context: HostToolDidExecuteContext) => HostToolResult | undefined | Promise<HostToolResult | undefined>,
  ): HostDisposable;
  decorateToolArguments(
    toolName: string,
    decorator: (args: unknown, context: HostToolDecoratorContext) => unknown | Promise<unknown>,
  ): HostDisposable;
  decorateToolExecution(
    toolName: string,
    decorator: (args: unknown, context: HostToolDecoratorContext) => unknown | Promise<unknown>,
  ): HostDisposable;
  onDidTurnEnd(listener: (event: { readonly turnId: number }) => void): HostDisposable;
}

export interface HostAgentClosedEvent {
  readonly sessionId: string;
  readonly agentId: string;
  readonly generation: number;
}

export interface HostSubagentSpawnedEvent {
  readonly sessionId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly description?: string;
}

export interface HostSessionWillCreateEvent {
  readonly sessionId: string;
  contributeMcpServer(name: string, config: McpServerConfig): void;
}

export interface HostExtension {
  onWillCreateSession?(event: HostSessionWillCreateEvent): void;
  onDidCreateSession?(session: HostSession): void;
  onDidCloseSession?(sessionId: string): void;
  onWillDeleteSession?(sessionId: string): void;
  onDidCreateAgent?(agent: HostAgent): void;
  onDidCloseAgent?(event: HostAgentClosedEvent): void;
  onDidSpawnSubagent?(event: HostSubagentSpawnedEvent): void;
  dispose?(): void;
}

function agentMeta(meta: AgentMeta | undefined): HostAgentMeta | undefined {
  if (meta === undefined) return undefined;
  return { type: meta.type, labels: meta.labels };
}

function createHostAgent(sessionId: string, context: AgentContext, handle: IAgentScopeHandle, meta?: AgentMeta): HostAgent {
  const loop = handle.accessor.get(IAgentLoopService);
  return {
    sessionId,
    id: context.agentId,
    generation: context.generation,
    meta: agentMeta(meta),
    state: () => {
      const snapshot = loop.snapshot();
      return {
        running: snapshot.state === 'running',
        turnId: snapshot.activeTurnId,
        profile: loop.data().profileName,
      };
    },
    loadsToolsOnDemand: () => {
      try {
        return handle.accessor.get(IAgentToolSelectService).enabled();
      } catch {
        return true;
      }
    },
    registerReminder: <D>(variant: string, provider: HostReminderProvider<D>) => handle.accessor.get(IAgentReminderService).register(
      variant,
      async (context: ContextInjectionContext<D>) => provider({
        lastInjection: context.lastInjection,
        lastDisclosure: context.lastDisclosure,
        isNewTurn: context.isNewTurn,
        signal: context.signal,
      }),
    ),
    onDidExecuteTool: (listener) => handle.accessor.get(IAgentToolExecutorService).registerHook({
      afterExecute: async (context) => {
        const legacy = legacyDidExecuteContext(context);
        const result = await listener({
          toolName: legacy.toolCall.name,
          outcome: legacy.outcome,
          output: legacy.result.output,
        });
        if (result !== undefined) return legacyRejectedResult(context, result.output);
      },
    }),
    decorateToolArguments: (toolName, decorator) => handle.accessor.get(IAgentToolExecutorService).registerHook({
      starting: async (context) => {
        if (context.call.name !== toolName || context.prepared.kind !== 'execute') return;
        const args = await decorator(context.args, { turnId: context.context.turnId });
        return { args };
      },
    }),
    decorateToolExecution: (toolName, decorator) => {
      const registry = handle.accessor.get(IAgentToolRegistryService);
      return handle.accessor.get(IAgentToolExecutorService).registerHook({
        beforeExecute: async (context) => {
          if (context.call.name !== toolName || context.prepared.kind !== 'execute') return;
          const args = await decorator(context.args, { turnId: context.context.turnId });
          const tool = registry.resolve(toolName);
          if (tool === undefined) return;
          const execution = await tool.resolveExecution(args);
          if (!('execute' in execution)) return;
          Object.assign(context, { args });
          Object.assign(context.prepared, {
            execution,
            accesses: execution.accesses,
            display: execution.display,
            description: execution.description,
            approvalRule: execution.approvalRule,
            matchesRule: execution.matchesRule,
          });
        },
      });
    },
    onDidTurnEnd: (listener) => handle.accessor.get(IEventBus).subscribe(TurnEnded, listener),
  };
}

export function createHostSessions(core: Scope): HostSessions {
  const sessions = core.accessor.get(ISessionManager);
  const wrappers = new Map<string, { readonly handle: ISessionScopeHandle; readonly value: HostSession }>();
  const wrap = (handle: ISessionScopeHandle): HostSession => {
    const cached = wrappers.get(handle.id);
    if (cached?.handle === handle) return cached.value;
    const lifecycle = handle.accessor.get(IAgentLifecycleService);
    const value: HostSession = {
      id: handle.id,
      agents: async () => {
        const metadata = await handle.accessor.get(ISessionMetadata).read().catch(() => undefined);
        const result: Record<string, HostAgentMeta> = {};
        for (const context of lifecycle.list()) {
          const meta = metadata?.agents?.[context.agentId];
          result[context.agentId] = agentMeta(meta) ?? {};
        }
        return result;
      },
      readAgentHistory: async (agentId) => {
        const agent = lifecycle.handleOf(agentId);
        if (agent === undefined) return [];
        return agent.accessor.get(IAgentLoopService).history() as readonly HostContextMessage[];
      },
      mcpServer: (name) => {
        const manager = handle.accessor.get(ISessionMcpHandle).connectionManager;
        const current = manager.get(name);
        if (current === undefined) return undefined;
        return { status: current.status, toolCount: manager.resolved(name)?.tools.length ?? 0 };
      },
      reconnectMcpServer: async (name) => {
        await handle.accessor.get(ISessionMcpHandle).connectionManager.reconnect(name);
      },
    };
    wrappers.set(handle.id, { handle, value });
    return value;
  };
  return {
    list: () => sessions.list().map(wrap),
    get: (sessionId) => {
      const handle = sessions.get(sessionId);
      return handle === undefined ? undefined : wrap(handle);
    },
  };
}

export function registerHostExtension(
  core: Scope,
  extension: HostExtension,
  hostSessions: HostSessions,
): HostDisposable {
  const manager = core.accessor.get(ISessionManager);
  if (manager.onWillCreateSession === undefined || manager.onDidCreateSession === undefined) {
    throw new Error('Session creation hooks are unavailable');
  }
  const attached = new Map<string, HostDisposable>();
  let disposed = false;
  const attach = (handle: ISessionScopeHandle): void => {
    if (disposed || attached.has(handle.id)) return;
    const lifecycle = handle.accessor.get(IAgentLifecycleService);
    const announced = new Set<string>();
    const announce = (context: AgentContext, agent: IAgentScopeHandle, meta?: AgentMeta): void => {
      const key = `${context.agentId}:${context.generation}`;
      if (announced.has(key)) return;
      announced.add(key);
      extension.onDidCreateAgent?.(createHostAgent(handle.id, context, agent, meta));
    };
    const disposables: IDisposable[] = [
      handle.accessor.get(ISessionEventBus).subscribe(SubagentSpawned, (event) => {
        const context = lifecycle.get(event.subagentId);
        if (context !== undefined) {
          extension.onDidSpawnSubagent?.({ sessionId: handle.id, agentId: event.subagentId, generation: context.generation, description: event.description });
        }
      }),
      lifecycle.onDidCreateScope(({ context, handle: agent, meta }) => {
        announce(context, agent, meta);
      }),
      lifecycle.onDidClose((context) => {
        extension.onDidCloseAgent?.({ sessionId: handle.id, agentId: context.agentId, generation: context.generation });
      }),
    ];
    attached.set(handle.id, { dispose: () => disposables.forEach((item) => item.dispose()) });
    void handle.accessor.get(ISessionMetadata).read().then((metadata) => {
      if (disposed || !attached.has(handle.id)) return;
      for (const context of lifecycle.list()) {
        const agent = lifecycle.handleOf(context.agentId);
        if (agent === undefined) continue;
        announce(context, agent, metadata.agents?.[context.agentId] ?? (context.agentId === MAIN_AGENT_ID ? { type: 'main' } : undefined));
      }
    }, () => {
      if (disposed || !attached.has(handle.id)) return;
      for (const context of lifecycle.list()) {
        const agent = lifecycle.handleOf(context.agentId);
        if (agent === undefined) continue;
        announce(context, agent, context.agentId === MAIN_AGENT_ID ? { type: 'main' } : undefined);
      }
    });
  };
  const detach = (sessionId: string): void => {
    attached.get(sessionId)?.dispose();
    attached.delete(sessionId);
  };
  const subscriptions: IDisposable[] = [
    manager.onWillCreateSession((event) => {
      extension.onWillCreateSession?.({
        sessionId: event.sessionId,
        contributeMcpServer: (name, config) => {
          event.contributeSeed(ISessionEphemeralMcpServers, {
            ...event.readSeed(ISessionEphemeralMcpServers),
            [name]: config,
          });
        },
      });
    }),
    manager.onDidCreateSession((event) => {
      attach(event.handle);
      const session = hostSessions.get(event.sessionId);
      if (session !== undefined) extension.onDidCreateSession?.(session);
    }),
  ];
  if (manager.onDidCloseSession !== undefined) {
    subscriptions.push(manager.onDidCloseSession(({ sessionId }) => {
      detach(sessionId);
      extension.onDidCloseSession?.(sessionId);
    }));
  }
  if (manager.onWillDeleteSession !== undefined) {
    subscriptions.push(manager.onWillDeleteSession(({ sessionId }) => extension.onWillDeleteSession?.(sessionId)));
  }
  for (const handle of manager.list()) {
    attach(handle);
    const session = hostSessions.get(handle.id);
    if (session !== undefined) extension.onDidCreateSession?.(session);
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      for (const sessionId of attached.keys()) detach(sessionId);
      extension.dispose?.();
    },
  };
}
