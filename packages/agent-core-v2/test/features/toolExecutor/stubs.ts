import { AsyncEmitter, type IWaitUntilData } from '#/_base/event';
import type { ToolExecutorRuntime } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { BeforeToolExecuteEmitter } from '#/features/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/features/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export interface ToolExecutorEventStubs {
  readonly executor: ToolExecutorRuntime;
  readonly didExecuteSlot: OrderedHookSlot<ToolDidExecuteContext>;
  fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined>;
  fireWillExecute(
    data: IWaitUntilData<WillExecuteToolEvent>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function stubToolExecutorEvents(): ToolExecutorEventStubs {
  const beforeEmitter = new BeforeToolExecuteEmitter();
  const willEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  const didExecuteSlot = new OrderedHookSlot<ToolDidExecuteContext>();
  const executor = {
    execute: async function* () {},
    onBeforeExecuteTool: beforeEmitter.event,
    onWillExecuteTool: willEmitter.event,
    hooks: { onDidExecuteTool: didExecuteSlot },
    recordDupType: () => {},
    registerToolCallGuard: () => ({ dispose() {} }),
    registerUnavailableToolDescriber: () => ({ dispose() {} }),
    registerMissingToolDescriber: () => ({ dispose() {} }),
  } as unknown as ToolExecutorRuntime;
  return {
    executor,
    didExecuteSlot,
    fireBeforeExecute: (context) => beforeEmitter.fireBeforeExecute(context),
    fireWillExecute: (data, signal) => willEmitter.fireAsync(data, signal),
  };
}

export function stubToolExecutorResolver(executor: ToolExecutorRuntime): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    resolve: () => executor,
  } as unknown as IAgentLifecycleService;
}
