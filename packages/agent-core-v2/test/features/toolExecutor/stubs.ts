import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Event, type IWaitUntilData } from '#/_base/event';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type {
  MissingToolDescriber,
  ToolCallGuard,
  ToolDidExecuteHook,
  ToolExecutionParticipationOrder,
  ToolExecutionResult,
  ToolExecutionVetoListener,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '#/features/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/features/toolExecutor/toolHooks';
import { AgentTools, type AgentToolsRuntime } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { BeforeToolExecuteBus } from '#/features/toolExecutor/internal/beforeToolExecute';
import type { ToolExecutorPipeline } from '#/features/toolExecutor/internal/executor';
import { TOOL_DEDUPE_PARTICIPANT } from '#/features/toolExecutor/toolExecutor';
import type { ToolCall } from '#/kosong/contract/message';
import type { ExecutableTool } from '#/tool/toolContract';
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

export function runtimeFromPipeline(
  pipeline: ToolExecutorPipeline,
  sharedTools: Map<string, ExecutableTool> = new Map(),
): AgentToolsRuntime {
  const tools = sharedTools;
  return {
    execute: (calls: ToolCall[], options: ToolExecutorExecuteOptions) =>
      pipeline.execute(calls, options),
    onWillExecute: pipeline.onWillExecute,
    onDidExecute: pipeline.onDidExecute,
    register: (tool: ExecutableTool) => { tools.set(tool.name, tool); return toDisposable(() => tools.delete(tool.name)); },
    resolve: (name: string) => tools.get(name),
    participateExecution: (name: string, listener: ToolExecutionVetoListener, order?: ToolExecutionParticipationOrder) =>
      pipeline.beforeExecuteBus.register(name, listener, order),
    registerDidExecuteHook: (name: string, hook: ToolDidExecuteHook, order?: ToolExecutionParticipationOrder) =>
      pipeline.registerDidExecuteHook(name, hook, order),
    registerToolCallGuard: (guard: ToolCallGuard) => pipeline.registerToolCallGuard(guard),
    registerUnavailableToolDescriber: (describer: UnavailableToolDescriber) =>
      pipeline.registerUnavailableToolDescriber(describer),
    registerMissingToolDescriber: (describer: MissingToolDescriber) =>
      pipeline.registerMissingToolDescriber(describer),
  } as unknown as AgentToolsRuntime;
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
