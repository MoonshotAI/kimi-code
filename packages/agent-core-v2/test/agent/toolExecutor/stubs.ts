/**
 * `toolExecutor` test stubs — a fireable executor event surface.
 *
 * Tests that drive `onBeforeExecuteTool` / `onWillExecuteTool` listeners
 * directly (rather than through `execute()`) register the SUT against this
 * stub executor and fire the real emitters it wraps, so the two-pass veto
 * semantics under test are the production ones.
 */

import { AsyncEmitter, type IWaitUntilData } from '#/_base/event';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorEventStubs {
  readonly executor: IAgentToolExecutorService;
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
  const executor: IAgentToolExecutorService = {
    _serviceBrand: undefined,
    execute: async function* () {},
    onBeforeExecuteTool: beforeEmitter.event,
    onWillExecuteTool: willEmitter.event,
    hooks: { onDidExecuteTool: didExecuteSlot },
    recordDupType: () => {},
    registerToolCallGuard: () => ({ dispose() {} }),
    registerUnavailableToolDescriber: () => ({ dispose() {} }),
    registerMissingToolDescriber: () => ({ dispose() {} }),
  };
  return {
    executor,
    didExecuteSlot,
    fireBeforeExecute: (context) => beforeEmitter.fireBeforeExecute(context),
    fireWillExecute: (data, signal) => willEmitter.fireAsync(data, signal),
  };
}
