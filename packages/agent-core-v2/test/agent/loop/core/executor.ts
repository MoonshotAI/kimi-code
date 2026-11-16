import type {
  ToolExecuteInput,
  ToolHookRegistration,
  ToolResult as LegacyToolResult,
  ToolStartingDecision as LegacyStartingDecision,
  ToolPermittingDecision as LegacyPermittingDecision,
  ToolEndingDecision as LegacyEndingDecision,
} from '@moonshot-ai/core/tool/executor';
import { toolExecutionFailureOf } from '@moonshot-ai/core/tool/executor';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import type { LoopToolContext, LoopToolExecutor } from '@moonshot-ai/core/loop/create-loop';
import {
  textToolContent,
  ToolExecutor,
  type AfterExecuteHookContext,
  type ToolDecision,
  type ToolDecisionContext,
  type ToolResult,
  type ToolReturn,
  type ToolStartingDecision,
} from '#/tool/executor';

export function executorFrom(
  names: readonly string[],
  execute: (input: ToolExecuteInput) => Promise<LegacyToolResult>,
  registrations: readonly ToolHookRegistration[] = [],
): LoopToolExecutor {
  const hook = {
    starting: (context: ToolDecisionContext<unknown, LoopToolContext>) => {
      for (const registration of registrations) {
        if (registration.point !== 'tool.starting') continue;
        const decision = registration.hook({
          toolCall: { ...context.call, arguments: JSON.stringify(context.args) },
          turnId: context.context.turnId,
          step: context.context.step,
          signal: context.signal,
        }, context.signal) as LegacyStartingDecision | void;
        if (decision !== undefined) return startingDecision(decision);
      }
      return undefined;
    },
    permitting: (context: ToolDecisionContext<unknown, LoopToolContext>) => {
      for (const registration of registrations) {
        if (registration.point !== 'tool.permitting') continue;
        const decision = registration.hook({
          toolCall: { ...context.call, arguments: JSON.stringify(context.args) },
          turnId: context.context.turnId,
          step: context.context.step,
          signal: context.signal,
        }, context.signal) as LegacyPermittingDecision | void;
        if (decision !== undefined) {
          if ('skipPermitting' in decision) return undefined;
          return startingDecision(decision) as ToolDecision;
        }
      }
      return undefined;
    },
    afterExecute: (context: AfterExecuteHookContext<unknown, LoopToolContext>) => {
      let result = context.result;
      for (const registration of registrations) {
        if (registration.point !== 'tool.ending') continue;
        const decision = registration.hook({
          toolCall: context.call,
          result: oldResult(result),
          failed: result.outcome.type !== 'success',
          turnId: context.context.turnId,
          step: context.context.step,
          signal: context.signal,
        }, context.signal) as LegacyEndingDecision | void;
        if (decision?.result !== undefined) result = newResult(result, decision.result.content);
      }
      return result;
    },
  };
  return new ToolExecutor<LoopToolContext>(names.map((name) => ({
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: true },
    execute: async (context) => {
      const input: ToolExecuteInput = {
        toolCall: { ...context.call, arguments: JSON.stringify(context.args) },
        signal: context.signal,
        turnId: context.context.turnId,
        step: context.context.step,
        onAdjudicated: () => {},
        onUpdate: (update) => {
          context.write(update.text);
        },
        detach: (value) => {
          const text = typeof value === 'string' ? value : value.text;
          context.onDetach(() => ({ content: textToolContent(text) }));
          context.detach(text);
        },
      };
      try {
        const result = await execute(input);
        return legacyResult(result);
      } catch (error) {
        const failure = toolExecutionFailureOf(error);
        if (failure !== undefined) return legacyResult(failure.result);
        throw error;
      }
    },
  })), { hook });
}

export function successfulExecutor(names: readonly string[], text = 'ok'): LoopToolExecutor {
  return executorFrom(names, async () => ({ content: textToolContent(text) }));
}

function startingDecision(decision: LegacyStartingDecision | LegacyPermittingDecision): ToolStartingDecision | ToolDecision {
  if ('toolCall' in decision) return { args: parseToolCallArguments(decision.toolCall.arguments).data };
  if ('skipPermitting' in decision) return { skipPermitting: true };
  const text = decision.blocked.message ?? decision.blocked.reason;
  return {
    reject: text,
    result: {
      content: decision.result?.content ?? textToolContent(text),
      outcome: 'failed',
      reason: text,
    },
  };
}

function legacyResult(result: LegacyToolResult): ToolReturn {
  if (result.isError === true) {
    return {
      content: result.content,
      outcome: 'failed',
      reason: result.content.map((part) => part.type === 'text' ? part.text : '').join('\n'),
    };
  }
  return { content: result.content, outcome: 'success' };
}

function oldResult(result: ToolResult): LegacyToolResult {
  return {
    content: result.content,
    isError: result.outcome.type === 'success' ? undefined : true,
  };
}

function newResult(previous: ToolResult, content: ToolResult['content']): ToolResult {
  return { ...previous, content };
}
