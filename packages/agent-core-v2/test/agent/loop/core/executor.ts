import type { ContentPart, ToolCall } from '@moonshot-ai/core/llm/message';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import type { LoopToolContext, LoopToolExecutor } from '@moonshot-ai/core/loop/create-loop';
import {
  textToolContent,
  ToolExecutor,
  type AfterExecuteHookContext,
  type ToolDecision,
  type ToolDecisionContext,
  type ToolResult as RuntimeToolResult,
  type ToolReturn,
  type ToolStartingDecision,
} from '#/tool/executor';

interface LegacyCause {
  readonly by?: string;
  readonly reason: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  durationMs?: number;
  blocked?: LegacyCause;
}

export interface ToolExecuteInput {
  toolCall: ToolCall;
  signal: AbortSignal;
  turnId?: number;
  step?: number;
  onUpdate?: (update: { key: string; text: string; percent?: number }) => void;
  detach?: (input: string | { text: string }) => void;
  onAdjudicated?: (final: ToolCall, blocked?: LegacyCause) => void;
}

interface LegacyStartingEvent {
  readonly toolCall: ToolCall;
  readonly turnId?: number;
  readonly step?: number;
  readonly signal: AbortSignal;
}

interface LegacyEndingEvent extends LegacyStartingEvent {
  readonly result: ToolResult;
  readonly failed: boolean;
}

type LegacyStartingDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: LegacyCause; readonly result?: ToolResult }
  | { readonly skipPermitting: true };

type LegacyPermittingDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: LegacyCause; readonly result?: ToolResult };

type LegacyEndingDecision = { readonly result?: ToolResult };

interface LegacyToolHooks {
  readonly 'tool.starting': (
    event: LegacyStartingEvent,
    signal: AbortSignal,
  ) => Promise<void | LegacyStartingDecision> | void | LegacyStartingDecision;
  readonly 'tool.permitting': (
    event: LegacyStartingEvent,
    signal: AbortSignal,
  ) => Promise<void | LegacyPermittingDecision> | void | LegacyPermittingDecision;
  readonly 'tool.ending': (
    event: LegacyEndingEvent,
    signal: AbortSignal,
  ) => Promise<void | LegacyEndingDecision> | void | LegacyEndingDecision;
}

export type ToolHookRegistration = {
  [P in keyof LegacyToolHooks]: {
    readonly point: P;
    readonly hook: LegacyToolHooks[P];
    readonly id?: string;
    readonly onFailure?: 'pause' | 'block';
  };
}[keyof LegacyToolHooks];

export function executorFrom(
  names: readonly string[],
  execute: (input: ToolExecuteInput) => Promise<ToolResult>,
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
      const result = await execute(input);
      return legacyResult(result);
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

function legacyResult(result: ToolResult): ToolReturn {
  if (result.isError === true) {
    return {
      content: result.content,
      outcome: 'failed',
      reason: result.content.map((part) => part.type === 'text' ? part.text : '').join('\n'),
    };
  }
  return { content: result.content, outcome: 'success' };
}

function oldResult(result: RuntimeToolResult): ToolResult {
  return {
    content: result.content,
    isError: result.outcome.type === 'success' ? undefined : true,
  };
}

function newResult(previous: RuntimeToolResult, content: RuntimeToolResult['content']): RuntimeToolResult {
  return { ...previous, content };
}
