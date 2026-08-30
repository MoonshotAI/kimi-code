import { createActor, type Actor } from 'xstate';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Event, type IWaitUntilData } from '#/_base/event';
import type { ServiceRegistration, TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionToolResultTruncationService } from '#/agent/toolResultTruncation/sessionToolResultTruncationService';
import type { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IAgentToolContributionSource } from '#/agent/toolRegistry/toolContributionSourceService';
import { IGitService } from '#/app/git/git';
import { IFlagService } from '#/app/flag/flag';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { registerLogServices } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';
import { registerTestAgentWireServices, stubAgentHostService } from '../../wire/stubs';
import type {
  MissingToolDescriber,
  ToolCallDupType,
  ToolCallGuard,
  ToolDidExecuteHook,
  ToolExecutionParticipationOrder,
  ToolExecutionResult,
  ToolExecutionVetoListener,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '#/actor/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/actor/toolExecutor/toolHooks';
import { AgentTools, AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { BeforeToolExecuteBus } from '#/actor/toolExecutor/internal/beforeToolExecute';
import {
  toolExecutorActorLogic,
  type ToolExecutorMachineContext,
} from '#/actor/toolExecutor/internal/toolExecutorMachine';
import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
} from '#/actor/toolExecutor/toolExecutor';
import type { ToolCall } from '#/kosong/contract/message';
import type { ExecutableTool, ToolSource } from '#/tool/toolContract';
import { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorEventStubs {
  readonly executor: AgentToolsRuntime;
  readonly beforeBus: BeforeToolExecuteBus;
  readonly didExecuteSlot: OrderedHookSlot<ToolDidExecuteContext>;
  fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined>;
  fireWillExecute(
    data: IWaitUntilData<WillExecuteToolEvent>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function stubToolExecutorEvents(input: {
  readonly execute?: (
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ) => AsyncIterable<ToolExecutionResult>;
} = {}): ToolExecutorEventStubs {
  const beforeBus = new BeforeToolExecuteBus();
  const willEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  const didExecuteSlot = new OrderedHookSlot<ToolDidExecuteContext>();
  const tools = new Map<string, ExecutableTool>();
  didExecuteSlot.register(TOOL_DEDUPE_PARTICIPANT, async (_ctx, next) => {
    await next();
  });
  const executor = {
    execute: input.execute ?? (async function* () {}),
    onWillExecute: willEmitter.event,
    onDidExecute: Event.None,
    register: (tool: ExecutableTool) => { tools.set(tool.name, tool); return toDisposable(() => tools.delete(tool.name)); },
    resolve: (name: string) => tools.get(name),
    participateExecution: (
      name: string,
      listener: Parameters<BeforeToolExecuteBus['register']>[1],
      order?: ToolExecutionParticipationOrder,
    ) => beforeBus.register(name, listener, order),
    registerDidExecuteHook: (
      name: string,
      hook: (ctx: ToolDidExecuteContext, next: (ctx?: ToolDidExecuteContext) => Promise<void>) => void | Promise<void>,
      order?: ToolExecutionParticipationOrder,
    ) =>
      didExecuteSlot.register(
        name,
        hook,
        order === 'postPolicy' ? {} : { before: TOOL_DEDUPE_PARTICIPANT },
      ),
    registerToolCallGuard: (_guard: ToolCallGuard): IDisposable => toDisposable(() => {}),
    registerUnavailableToolDescriber: (_describer: UnavailableToolDescriber): IDisposable =>
      toDisposable(() => {}),
    registerMissingToolDescriber: (_describer: MissingToolDescriber): IDisposable =>
      toDisposable(() => {}),
  } as unknown as AgentToolsRuntime;
  return {
    executor,
    beforeBus,
    didExecuteSlot,
    fireBeforeExecute: (context) => beforeBus.fireBeforeExecute(context),
    fireWillExecute: (data, signal) => willEmitter.fireAsync(data, signal),
  };
}

export function lifecycleWithToolExecutor(
  executor: AgentToolsRuntime,
  inner?: IAgentLifecycleService,
  firedScopeContext?: AgentContext,
): IAgentLifecycleService {
  return {
    resolve: (agent: unknown, definition: unknown) => {
      if (definition === AgentTools) return executor;
      return inner?.resolve(agent as never, definition as never);
    },
    get: (agentId: unknown) => inner?.get(agentId as never) ?? ({} as AgentContext),
    onDidCreate: (listener: (event: AgentContext) => void) => {
      if (firedScopeContext !== undefined) listener(firedScopeContext);
      return inner?.onDidCreate?.(listener as never) ?? toDisposable(() => {});
    },
  } as unknown as IAgentLifecycleService;
}

export function stubExecutorHarnessLifecycle(): IAgentLifecycleService {
  return {
    resolve: () => {
      throw new Error('runtime resolve is not available in the executor machine harness');
    },
    get: () => undefined,
    onDidCreate: () => toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}

export function stubSessionMcpHandle(): ISessionMcpHandle {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    isBaselineServer: () => false,
    connectionManager: {
      list: () => [],
      onStatusChange: () => () => {},
      resolved: () => undefined,
      get: () => undefined,
      reconnect: async () => {},
      reconnectAndJoin: async () => {},
      getRemoteServerUrl: () => undefined,
      initialLoadDurationMs: () => 0,
      oauthService: undefined,
    },
  } as unknown as ISessionMcpHandle;
}

export function stubToolContributionSource(): IAgentToolContributionSource {
  const emptyView = { items: [], onDidChange: () => toDisposable(() => {}) };
  return {
    _serviceBrand: undefined,
    view: emptyView,
    providers: emptyView,
  } as unknown as IAgentToolContributionSource;
}

export function registerMachineExecutorTestServices(
  reg: ServiceRegistration,
  getService: <T>(id: never) => T,
  agentScope: IAgentScopeContext,
  options: {
    readonly telemetry: ITelemetryService;
    readonly wireScope?: string;
  },
): void {
  registerStateServices(reg);
  registerTestAgentWireServices(reg, options.wireScope ?? 'wire/tool-executor', agentScope);
  reg.defineInstance(IAgentHostService, stubAgentHostService(getService, agentScope));
  reg.defineInstance(ITelemetryService, options.telemetry);
  reg.defineInstance(IEventBus, {
    _serviceBrand: undefined,
    publish: () => {},
    subscribe: () => ({ dispose: () => {} }),
  } as unknown as IEventBus);
  reg.defineInstance(ISessionToolResultTruncationService, {
    _serviceBrand: undefined,
    attach: () => {},
    of: () => ({
      _serviceBrand: undefined,
      truncateForModel: (
        input: Parameters<IAgentToolResultTruncationService['truncateForModel']>[0],
      ) => Promise.resolve(input.result),
    }),
  } as unknown as ISessionToolResultTruncationService);
  reg.defineInstance(IAgentLifecycleService, stubExecutorHarnessLifecycle());
  reg.defineInstance(ISessionMcpHandle, stubSessionMcpHandle());
  reg.defineInstance(IAgentToolContributionSource, stubToolContributionSource());
  reg.defineInstance(IFlagService, {
    _serviceBrand: undefined,
    enabled: () => false,
  } as unknown as IFlagService);
  reg.defineInstance(ISessionContext, {
    _serviceBrand: undefined,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: '/tmp/tool-executor-machine-session',
    metaScope: 'sessions/workspace-1/session-1',
    cwd: '/tmp/tool-executor-machine-session',
    scope: (sub?: string): string =>
      sub ? `sessions/workspace-1/session-1/${sub}` : 'sessions/workspace-1/session-1',
  } satisfies ISessionContext);
  reg.defineInstance(ISessionWorkspaceContext, {} as unknown as ISessionWorkspaceContext);
  reg.defineInstance(IGitService, {} as unknown as IGitService);
  registerLogServices(reg);
}

export function fireBeforeExecuteOf(
  runtime: AgentToolsRuntime,
): (context: ResolvedToolExecutionHookContext) => Promise<BeforeExecuteDecision | undefined> {
  const context = (runtime as unknown as { context: AgentRuntimeContext<unknown> }).context;
  return (hookContext) =>
    context.getLogicState<ToolExecutorMachineContext>().vetoBus.fireBeforeExecute(hookContext);
}

export interface MachineToolRegistry {
  register(tool: ExecutableTool, options?: { readonly source?: ToolSource }): IDisposable;
}

export interface MachineExecutorHarness {
  readonly executor: AgentToolsRuntime;
  readonly runtimeContext: AgentRuntimeContext<unknown>;
  machine(): ToolExecutorMachineContext;
  readonly registry: MachineToolRegistry;
  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;
  registerDidExecuteHook(name: string, hook: ToolDidExecuteHook): IDisposable;
  participateExecution(name: string, listener: ToolExecutionVetoListener): IDisposable;
  dispose(): void;
}

export function createMachineExecutorHarness(input: {
  readonly ix: TestInstantiationService;
  readonly agentContext: AgentContext;
  readonly realDedupe?: boolean;
}): MachineExecutorHarness {
  let actor: Actor<typeof toolExecutorActorLogic> | undefined;
  const runtimeContext: AgentRuntimeContext<unknown> = {
    agent: input.agentContext,
    get: (id) => input.ix.get(id as never),
    getState: () => {
      throw new Error('no durable state');
    },
    getLogicState: <T,>() => actor!.getSnapshot().context as T,
    dispatch: (event) => input.ix.get(IEventDispatcher).dispatch(event),
    send: (event) => {
      actor!.send(event as never);
    },
    onDidChange: Event.None,
  };
  actor = createActor(toolExecutorActorLogic, { input: runtimeContext });
  actor.start();
  const machine = (): ToolExecutorMachineContext =>
    runtimeContext.getLogicState<ToolExecutorMachineContext>();
  const context = machine();
  context.guardSlot.current = undefined;
  context.unavailableDescriberSlot.current = undefined;
  context.missingDescriberSlot.current = undefined;
  context.vetoBus.register(PERMISSION_GATE_PARTICIPANT, () => {});
  if (input.realDedupe !== true) {
    context.vetoBus.register(TOOL_DEDUPE_PARTICIPANT, () => {});
    context.didHooks.register(TOOL_DEDUPE_PARTICIPANT, async (_ctx, next) => {
      await next();
    });
  }
  const executor = new AgentToolsRuntime(runtimeContext);
  const owner = { name: 'test-registry' };
  const tools = new Map<string, { tool: ExecutableTool; source: ToolSource }>();
  const sync = (): void => {
    runtimeContext.send({
      type: 'toolExecutor.catalogSourceSet',
      owner,
      entries: [...tools.values()],
    });
  };
  return {
    executor,
    runtimeContext,
    machine,
    registry: {
      register: (tool, options = {}) => {
        tools.set(tool.name, { tool, source: options.source ?? 'builtin' });
        sync();
        return toDisposable(() => {
          tools.delete(tool.name);
          sync();
        });
      },
    },
    recordDupType: (toolCallId, dupType) => {
      machine().dedupe.dupTypes.set(toolCallId, dupType);
    },
    registerDidExecuteHook: (name, hook) => executor.registerDidExecuteHook(name, hook),
    participateExecution: (name, listener) => executor.participateExecution(name, listener),
    dispose: () => {
      actor!.stop();
    },
  };
}
