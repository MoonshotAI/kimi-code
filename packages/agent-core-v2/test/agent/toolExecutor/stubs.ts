import { type IWaitUntilData } from '#/_base/event';
import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentToolExecutorService, AgentToolHook } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import type { LegacyAfterContext, LegacyDecisionContext } from '#/agent/toolExecutor/legacyHooks';
import { OrderedHookSlot } from '#/hooks';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import {
  composeToolExecutorHooks,
  textToolContent,
  ToolExecutor,
  type ToolReturn,
} from '#/tool/executor';

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
  const didExecuteSlot = new OrderedHookSlot<ToolDidExecuteContext>();
  const beforeEmitter = new BeforeToolExecuteEmitter();
  const hooks: AgentToolHook[] = [];
  const executor: IAgentToolExecutorService = {
    _serviceBrand: undefined,
    executor: new ToolExecutor([]),
    registerLegacyStarting: (listener) => beforeEmitter.event(listener),
    registerHook(hook) {
      hooks.push(hook);
      const afterExecute = hook.afterExecute;
      if (afterExecute !== undefined) {
        didExecuteSlot.register(`hook-${String(hooks.length)}`, async (context, next) => {
          await afterExecute(afterContext(context));
          await next();
        });
      }
      return toDisposable(() => {
        const index = hooks.indexOf(hook);
        if (index >= 0) hooks.splice(index, 1);
      });
    },
    handlers: () => [],
    handler: () => undefined,
    handlerForCall: () => undefined,
    release: () => {},
    recordDupType: () => {},
  };
  return {
    executor,
    didExecuteSlot,
    fireBeforeExecute: async (context) => {
      const beforeDecision = await beforeEmitter.fireBeforeExecute(context);
      if (beforeDecision !== undefined) return beforeDecision;
      const decisionContext = decisionContextOf(context);
      const starting = await composeToolExecutorHooks(hooks).starting?.(decisionContext);
      if (starting !== undefined && 'skipPermitting' in starting) return { allow: true };
      if (starting !== undefined && 'reject' in starting && starting.result !== undefined) {
        return { veto: oldResult(starting.result) };
      }
      const permitting = await composeToolExecutorHooks(hooks).permitting?.(decisionContext);
      if (permitting !== undefined && 'reject' in permitting && permitting.result !== undefined) {
        return { veto: oldResult(permitting.result) };
      }
      return decisionContext.context.metadata === undefined
        ? undefined
        : { executionMetadata: decisionContext.context.metadata };
    },
    fireWillExecute: async (data, signal) => {
      await composeToolExecutorHooks(hooks).beforeExecute?.(decisionContextOf({
        ...data,
        toolCalls: [data.toolCall],
        signal,
      }));
    },
  };
}

function decisionContextOf(context: ResolvedToolExecutionHookContext): LegacyDecisionContext {
  return {
    ...context,
    call: context.toolCall,
    taskId: 'stub-task',
    context: { turnId: context.turnId, trace: context.trace },
    prepared: {
      kind: 'execute',
      execution: context.execution,
      approvalRule: context.execution.approvalRule,
      accesses: context.execution.accesses,
      display: context.execution.display,
      description: context.execution.description,
    },
  };
}

function afterContext(context: ToolDidExecuteContext): LegacyAfterContext {
  const result = context.result;
  const output = typeof result.output === 'string' ? textToolContent(result.output) : result.output;
  const fields: Record<string, unknown> = {};
  const resolved = decisionContextOf({
    ...context,
    execution: {
      approvalRule: context.toolCall.name,
      accesses: context.accesses,
      execute: async () => context.result,
    },
  });
  if (resolved.prepared.kind === 'execute') resolved.prepared.result = result;
  return {
    ...resolved,
    prepared: context.outcome === 'executed' || context.outcome === 'aborted'
      ? resolved.prepared
      : { kind: 'synthetic', result, durationMs: 0 },
    fields,
    set: (update) => Object.assign(fields, update),
    result: {
      toolCallId: context.toolCall.id,
      content: output,
      outcome: result.isError === true
        ? {
            type: 'failed',
            error: {
              outcome: 'failed',
              type: 'error',
              phase: 'execute',
              reason: output.map((part) => part.type === 'text' ? part.text : '').join('\n'),
            },
          }
        : { type: 'success' },
    },
  };
}

function oldResult(result: ToolReturn): ToolDidExecuteContext['result'] {
  return {
    output: result.content.every((part) => part.type === 'text')
      ? result.content.map((part) => part.type === 'text' ? part.text : '').join('\n')
      : result.content,
    isError: result.outcome === 'failed' ? true : undefined,
  };
}
