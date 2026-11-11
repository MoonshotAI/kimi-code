import { AsyncEmitter } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentToolExecutorService } from './toolExecutor';
import type { AfterExecuteHookContext, ToolDecisionContext, ToolResult, ToolStartingDecision } from '#/tool/executor';
import { toLegacyToolReturn } from '#/tool/executor';
import type { LegacyToolAgentContext, LegacyToolPreparation } from '#/tool/executor';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from './toolHooks';

export type LegacyDecisionContext = ToolDecisionContext<unknown, LegacyToolAgentContext, LegacyToolPreparation>;
export type LegacyAfterContext = AfterExecuteHookContext<unknown, LegacyToolAgentContext, LegacyToolPreparation>;

export function legacyExecutionContext(
  context: LegacyDecisionContext,
): ResolvedToolExecutionHookContext {
  if (context.prepared.kind !== 'execute') throw new Error('Legacy tool is not executable');
  return {
    turnId: context.context.turnId,
    signal: context.signal,
    trace: context.context.trace,
    toolCall: { ...context.call, arguments: JSON.stringify(context.args) },
    toolCalls: [context.call],
    args: context.args,
    execution: context.prepared.execution,
  };
}

export function registerLegacyStarting(
  toolExecutor: IAgentToolExecutorService,
  listener: (event: BeforeToolExecuteEvent) => void | Promise<void>,
): IDisposable {
  return toolExecutor.registerLegacyStarting(listener);
}

export async function runLegacyStarting(
  context: LegacyDecisionContext,
  listener: (event: BeforeToolExecuteEvent) => void | Promise<void>,
): Promise<ToolStartingDecision | void> {
  const emitter = new BeforeToolExecuteEmitter();
  emitter.event(listener);
  const decision = await emitter.fireBeforeExecute(legacyExecutionContext(context));
  return legacyStartingDecision(context, decision);
}

export function legacyStartingDecision(
  context: LegacyDecisionContext,
  decision: BeforeExecuteDecision | undefined,
): ToolStartingDecision | void {
  if (decision?.allow === true) return { skipPermitting: true };
  if (decision?.veto !== undefined) {
    const result = toLegacyToolReturn(decision.veto, context.call.name);
    return {
      reject: textOf(decision.veto),
      result,
    };
  }
  if (decision?.executionMetadata !== undefined) {
    (context.context as { metadata?: unknown }).metadata = decision.executionMetadata;
  }
  return undefined;
}

export function legacySkipPermitting(): ToolStartingDecision {
  return { skipPermitting: true };
}

export async function runLegacyBeforeExecute(
  context: LegacyDecisionContext,
  listener: (event: WillExecuteToolEvent) => void,
): Promise<void> {
  const emitter = new AsyncEmitter<WillExecuteToolEvent>();
  emitter.event(listener);
  await emitter.fireAsync(legacyExecutionContext(context), context.signal);
}

export function legacyDidExecuteContext(context: LegacyAfterContext): ToolDidExecuteContext {
  const prepared = context.prepared;
  const failure = context.result.outcome.type === 'failed' ? context.result.outcome.error : undefined;
  const outcome = prepared?.kind === 'synthetic'
    ? 'synthetic'
    : failure?.type === 'invalid'
      ? 'preflight-rejected'
      : failure?.phase === 'resolve'
        ? 'resolution-failed'
        : failure?.phase === 'starting' || failure?.phase === 'permitting'
          ? 'vetoed'
          : context.result.outcome.type === 'aborted' ? 'aborted' : 'executed';
  return {
    turnId: context.context.turnId,
    signal: context.signal,
    trace: context.context.trace,
    toolCall: context.call,
    toolCalls: [context.call],
    args: context.args,
    outcome,
    accesses: prepared?.kind === 'execute' ? prepared.accesses : undefined,
    result: legacyResultOf(context),
  };
}

export function legacyResultOf(context: LegacyAfterContext): ExecutableToolResult {
  const prepared = context.prepared;
  if (prepared?.kind === 'synthetic') return prepared.result;
  if (prepared?.kind === 'execute' && prepared.result !== undefined) return prepared.result;
  const content = context.result.content;
  return {
    output: content.every((part) => part.type === 'text')
      ? content.map((part) => part.type === 'text' ? part.text : '').join('')
      : content,
    isError: context.result.outcome.type === 'success' ? undefined : true,
  };
}

export function legacyRejectedResult(context: LegacyAfterContext, text: string): ToolResult {
  return {
    toolCallId: context.call.id,
    content: [{ type: 'text', text }],
    outcome: {
      type: 'failed',
      error: {
        outcome: 'failed',
        type: 'rejected',
        phase: 'starting',
        reason: text,
      },
    },
  };
}

function textOf(result: ExecutableToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return result.output.map((part) => part.type === 'text' ? part.text : '').join('\n');
}
