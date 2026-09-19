import { assign, fromPromise, setup } from '#/xstate2/index';

import {
  createAssistantEntry,
  createToolEntry,
  createToolMessage,
  toInputMessages,
  type AssistantEntry,
  type HistoryMessage,
  type ToolCall,
  type ToolDescription,
  type ToolEntry,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmEvent } from '#/llm/requester/input';
import { createRequestActor } from './llm-actor';
import type { LlmCredentialProvider, LlmRequestConfig } from '#/llm/requester/requester';
import type { LlmOutput } from '#/llm/requester/settle';
import { ToolCallIdNormalizer } from '#/llm/requester/tool-call-id';
import type { ToolResult } from '#/tool';
import type { ToolOutput } from './tool';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';

import { usedContextTokens } from '#/llm/usage';

function modelMeta(model: LlmModel): { model: { provider: string; model: string } } {
  return { model: { provider: model.provider, model: model.model } };
}

export interface TurnRequest {
  readonly config: LlmRequestConfig;
  readonly systemPrompt?: string;
  readonly credentialProvider?: LlmCredentialProvider;
  readonly maxContextTokens?: number;
}

export interface TurnInput {
  request: TurnRequest;
  history: readonly HistoryMessage[];
  maxSteps?: number;
  parentSignal?: AbortSignal;
}

export type TurnToolEvent =
  | { type: 'tool.detached'; toolCallId: string; text: string }
  | { type: 'tool.done'; toolCallId: string; result: ToolResult }
  | { type: 'tool.failed'; toolCallId: string; error: unknown }
  | { type: 'tool.aborted'; toolCallId: string };

export type TurnEvent =
  | LlmEvent
  | TurnToolEvent
  | { type: 'agent.notify'; messages: HistoryMessage[] }
  | { type: 'turn.pause' }
  | { type: 'turn.continue' }
  | { type: 'turn.abort'; reason?: unknown };

export type TurnLlmEvent =
  | Exclude<LlmEvent, { type: 'llm.done' }>
  | { type: 'llm.done'; entry: AssistantEntry };

export type TurnSignal =
  | { type: 'step.started'; step: number }
  | { type: 'turn.spawn_tools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' };

export const LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE = 'loop.max_steps_exceeded';

export type MaxStepsExceeded = {
  readonly reason: 'max_steps';
  readonly code: typeof LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE;
  readonly message: string;
  readonly details: { maxSteps: number };
};

export type TurnFailure =
  | MaxStepsExceeded
  | { readonly reason: 'error'; readonly error?: unknown };

export type TurnInterruptReason = TurnFailure['reason'];

export function createMaxStepsExceeded(maxSteps: number, message?: string): MaxStepsExceeded {
  return {
    reason: 'max_steps',
    code: LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE,
    message:
      message ??
      `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    details: { maxSteps },
  };
}

export type TurnOutput =
  | { type: 'done'; produced: HistoryMessage[] }
  | { type: 'failed'; failure: TurnFailure; produced: HistoryMessage[] }
  | { type: 'aborted'; produced: HistoryMessage[] };

export interface TurnMachineContext {
  input: TurnInput;
  history: HistoryMessage[];
  toolCallIds: ToolCallIdNormalizer;
  llmScope: AbortScope;
  pendingToolCalls: ToolCall[];
  outcomes: Record<string, ToolOutput>;
  steps: number;
  step: number;
  paused: boolean;
  outcome?: 'done' | 'failed' | 'aborted';
  failure?: TurnFailure;
}

function assistantEntry(
  context: TurnMachineContext,
  output: LlmOutput,
  source: string,
): AssistantEntry {
  return createAssistantEntry(output.message, {
    source,
    ...modelMeta(context.input.request.config.model),
    usage: output.usage,
    headers: output.headers,
    finish: output.finish,
    messageId: output.messageId,
  });
}

function toolOutcomeEntry(toolCall: ToolCall, output: ToolOutput): ToolEntry {
  if (output.type === 'failed') {
    const text = output.error instanceof Error ? output.error.message : String(output.error);
    return createToolEntry(createToolMessage(toolCall.id, text), { source: 'tool' });
  }
  if (output.type === 'aborted') {
    return createToolEntry(createToolMessage(toolCall.id, 'aborted'), { source: 'tool' });
  }
  return createToolEntry(createToolMessage(toolCall.id, output.result.content), {
    source: 'tool',
  });
}

function asyncAckOutcome(toolCall: ToolCall, text: string): ToolOutput {
  return {
    type: 'succeeded',
    result: {
      content: [
        { type: 'text', text: text === '' ? `async running: ${toolCall.name}` : text },
      ],
    },
  };
}

function collectToolOutcomes(
  context: TurnMachineContext,
): Pick<TurnMachineContext, 'history' | 'pendingToolCalls' | 'outcomes'> {
  return {
    history: [
      ...context.history,
      ...context.pendingToolCalls.map((toolCall) =>
        toolOutcomeEntry(toolCall, context.outcomes[toolCall.id] as ToolOutput),
      ),
    ],
    pendingToolCalls: [],
    outcomes: {},
  };
}

function abortOutcomes(context: TurnMachineContext): Record<string, ToolOutput> {
  const outcomes = { ...context.outcomes };
  for (const toolCall of context.pendingToolCalls) {
    if (outcomes[toolCall.id] === undefined) {
      outcomes[toolCall.id] = { type: 'aborted' };
    }
  }
  return outcomes;
}

function maxStepsExceeded(context: TurnMachineContext): boolean {
  const maxSteps = context.input.maxSteps;
  return maxSteps !== undefined && maxSteps > 0 && context.steps >= maxSteps;
}

export interface TurnBeforeStepContext {
  messages: readonly HistoryMessage[];
  request: TurnRequest;
  tools: readonly ToolDescription[];
  systemPrompt?: string;
}

export type TurnBeforeStep = (context: TurnBeforeStepContext) => void | Promise<void>;

export type LlmActorLogic = ReturnType<typeof createRequestActor>;

function withCompletionBudget(
  request: TurnRequest,
  history: readonly HistoryMessage[],
  tools: readonly ToolDescription[] | undefined,
  systemPrompt: string | undefined,
): LlmRequestConfig {
  const maxCompletionTokens = request.config.maxCompletionTokens;
  const maxContextTokens = request.maxContextTokens;
  if (maxCompletionTokens === undefined) {
    return request.config;
  }
  let cap = maxCompletionTokens;
  if (maxContextTokens !== undefined && maxContextTokens > 0) {
    cap = Math.min(
      cap,
      maxContextTokens -
        usedContextTokens(history, {
          systemPrompt,
          tools,
        }),
    );
  }
  cap = Math.max(1, cap);
  if (cap === maxCompletionTokens) {
    return request.config;
  }
  return { ...request.config, maxCompletionTokens: cap };
}

export interface CreateTurnMachineOptions {
  readonly abortGraceMs?: number;
  readonly getTools?: () => readonly ToolDescription[] | undefined;
  readonly getSystemPrompt?: (host?: string) => string | undefined;
  readonly onBeforeStep?: TurnBeforeStep;
}

export type TurnLogic = ReturnType<typeof createTurnMachine>;

export function createTurnMachine(
  llmActor: LlmActorLogic,
  options?: CreateTurnMachineOptions,
) {
  const abortGraceMs = options?.abortGraceMs ?? 2_500;
  const toolsFor = (): readonly ToolDescription[] | undefined => options?.getTools?.();
  const systemPromptFor = (host?: string): string | undefined =>
    options?.getSystemPrompt === undefined ? host : options.getSystemPrompt(host);
  return setup({
    types: {
      input: {} as TurnInput,
      context: {} as TurnMachineContext,
      events: {} as TurnEvent,
      output: {} as TurnOutput,
    },
    actors: {
      llmActor,
      onBeforeStepActor: fromPromise<void, TurnBeforeStepContext>(async ({ input }) => {
        await options?.onBeforeStep?.(input);
      }),
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      signalParent: ({ self }, params: TurnSignal) => {
        self._parent?.send(params);
      },
      sendToParent: ({ self }, params: TurnLlmEvent) => {
        self._parent?.send(params);
      },
      collectAborted: assign(({ context }) =>
        collectToolOutcomes({ ...context, outcomes: abortOutcomes(context) }),
      ),
    },
    delays: {
      abortGrace: abortGraceMs,
    },
  }).createMachine({
    id: 'turn',
    initial: 'gating',
    context: ({ input }) => {
      const toolCallIds = new ToolCallIdNormalizer();
      toolCallIds.seedFrom(toInputMessages(input.history));
      return {
        input,
        history: [...input.history],
        toolCallIds,
        llmScope: createAbortScope(),
        pendingToolCalls: [],
        outcomes: {},
        steps: 1,
        step: 0,
        paused: false,
      };
    },
    on: {
      'turn.pause': {
        actions: assign({ paused: true }),
      },
      'turn.continue': {
        actions: assign({ paused: false }),
      },
    },
    states: {
      gating: {
        always: [{ guard: () => options?.onBeforeStep === undefined, target: 'streaming' }],
        invoke: {
          src: 'onBeforeStepActor',
          input: ({ context }) => {
            const request = context.input.request;
            return {
              messages: context.history,
              request,
              tools: toolsFor() ?? [],
              systemPrompt: systemPromptFor(request.systemPrompt),
            };
          },
          onDone: { target: 'streaming' },
          onError: {
            target: 'failed',
            actions: assign({
              outcome: 'failed' as const,
              failure: ({ event }) => ({ reason: 'error' as const, error: event.error }),
            }),
          },
        },
        on: {
          'turn.abort': {
            target: 'aborted',
            actions: assign({ outcome: 'aborted' as const }),
          },
        },
      },
      streaming: {
        initial: 'requesting',
        on: {
          'turn.abort': {
            actions: ({ context, event }) => {
              context.llmScope.abort(event.reason);
            },
          },
        },
        states: {
          requesting: {
            entry: [
              assign({
                llmScope: ({ context }) =>
                  context.input.parentSignal !== undefined
                    ? withAbort(context.input.parentSignal)
                    : createAbortScope(),
                step: ({ context }) => context.step + 1,
              }),
              {
                type: 'signalParent',
                params: ({ context }) => ({ type: 'step.started' as const, step: context.step }),
              },
            ],
            invoke: {
              src: 'llmActor',
              input: ({ context }) => {
                const request = context.input.request;
                const tools = toolsFor();
                const systemPrompt = systemPromptFor(request.systemPrompt);
                return {
                  config: withCompletionBudget(request, context.history, tools, systemPrompt),
                  content: {
                    systemPrompt,
                    messages: toInputMessages(context.history),
                    tools,
                  },
                  signal: context.llmScope.signal,
                  toolCallIds: context.toolCallIds,
                  credentialProvider: request.credentialProvider,
                };
              },
              onError: {
                target: '#turn.failed',
                actions: assign({
                  outcome: 'failed' as const,
                  failure: ({ event }) => ({ reason: 'error' as const, error: event.error }),
                }),
              },
            },
            on: {
              'llm.sent': {
                actions: [
                  {
                    type: 'sendToParent',
                    params: { type: 'llm.sent' as const },
                  },
                ],
              },
              'llm.streaming.headers': { actions: 'forwardToParent' },
              'llm.streaming.part': { actions: 'forwardToParent' },
              'llm.streaming.usage': { actions: 'forwardToParent' },
              'llm.streaming.finish': { actions: 'forwardToParent' },
              'llm.streaming.message_id': { actions: 'forwardToParent' },
              'llm.retrying': { actions: 'forwardToParent' },
              'llm.recovering': { actions: 'forwardToParent' },
              'llm.aborted': {
                target: '#turn.aborted',
                actions: [
                  'forwardToParent',
                  assign(({ context, event }) => {
                    const message = event.message;
                    return {
                      outcome: 'aborted' as const,
                      history:
                        message === null
                          ? context.history
                          : [
                              ...context.history,
                              assistantEntry(context, { ...event, message }, 'salvaged'),
                            ],
                    };
                  }),
                ],
              },
              'llm.done': [
                {
                  guard: ({ event }) => event.message.toolCalls.length > 0,
                  target: '#turn.acting',
                  actions: [
                    assign(({ context, event }) => {
                      const entry = assistantEntry(context, event, 'llm');
                      return {
                        history: [...context.history, entry],
                        pendingToolCalls: [...entry.message.toolCalls],
                      };
                    }),
                    {
                      type: 'sendToParent',
                      params: ({ context }) => ({
                        type: 'llm.done' as const,
                        entry: context.history[context.history.length - 1] as AssistantEntry,
                      }),
                    },
                  ],
                },
                {
                  target: '#turn.done',
                  actions: [
                    assign({
                      history: ({ context, event }) => [
                        ...context.history,
                        assistantEntry(context, event, 'llm'),
                      ],
                    }),
                    {
                      type: 'sendToParent',
                      params: ({ context }) => ({
                        type: 'llm.done' as const,
                        entry: context.history[context.history.length - 1] as AssistantEntry,
                      }),
                    },
                  ],
                },
              ],
              'llm.failed.syntax': {
                target: '#turn.failed',
                actions: [
                  'forwardToParent',
                  assign({
                    outcome: 'failed' as const,
                    failure: ({ event }) => ({ reason: 'error' as const, error: event.error }),
                  }),
                ],
              },
              'llm.failed.remote': {
                target: '#turn.failed',
                actions: [
                  'forwardToParent',
                  assign({
                    outcome: 'failed' as const,
                    failure: ({ event }) => ({
                      reason: 'error' as const,
                      error: event.rawError ?? event.error,
                    }),
                  }),
                ],
              },
            },
          },
        },
      },
      acting: {
        entry: {
          type: 'signalParent',
          params: ({ context }) => ({
            type: 'turn.spawn_tools' as const,
            toolCalls: context.pendingToolCalls,
          }),
        },
        initial: 'running',
        always: [
          {
            guard: ({ context }) =>
              context.outcome === 'aborted' &&
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'aborted',
            actions: assign(({ context }) => collectToolOutcomes(context)),
          },
          {
            guard: ({ context }) =>
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'draining',
            actions: assign(({ context }) => collectToolOutcomes(context)),
          },
        ],
        on: {
          'tool.detached': {
            guard: ({ context, event }) => context.outcomes[event.toolCallId] === undefined,
            actions: assign(({ context, event }) => {
              const toolCall = context.pendingToolCalls.find(
                (call) => call.id === event.toolCallId,
              );
              if (toolCall === undefined) {
                return {};
              }
              return {
                outcomes: {
                  ...context.outcomes,
                  [event.toolCallId]: asyncAckOutcome(toolCall, event.text),
                },
              };
            }),
          },
          'tool.done': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'succeeded', result: event.result },
              }),
            }),
          },
          'tool.failed': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'failed', error: event.error },
              }),
            }),
          },
          'tool.aborted': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'aborted' },
              }),
            }),
          },
        },
        states: {
          running: {
            on: {
              'turn.abort': {
                target: 'aborting',
                actions: assign({ outcome: 'aborted' as const }),
              },
            },
          },
          aborting: {
            after: {
              abortGrace: {
                target: '#turn.aborted',
                actions: 'collectAborted',
              },
            },
            on: {
              'turn.abort': {
                target: '#turn.aborted',
                actions: 'collectAborted',
              },
            },
          },
        },
      },
      draining: {
        entry: {
          type: 'signalParent',
          params: { type: 'turn.drain' },
        },
        on: {
          'agent.notify': [
            {
              guard: ({ context }) => context.paused,
              target: 'done',
              actions: assign(({ context, event }) => ({
                history: [...context.history, ...event.messages],
              })),
            },
            {
              guard: ({ context, event }) =>
                event.messages.length === 0 && maxStepsExceeded(context),
              target: 'failed',
              actions: assign(({ context }) => ({
                outcome: 'failed' as const,
                failure: createMaxStepsExceeded(context.input.maxSteps as number),
              })),
            },
            {
              target: 'gating',
              actions: assign(({ context, event }) => ({
                history: [...context.history, ...event.messages],
                steps: event.messages.length > 0 ? 1 : context.steps + 1,
              })),
            },
          ],
          'turn.abort': {
            target: 'aborted',
            actions: assign({ outcome: 'aborted' as const }),
          },
        },
      },
      done: { type: 'final' },
      failed: { type: 'final' },
      aborted: { type: 'final' },
    },
    output: ({ context }): TurnOutput => {
      const produced = context.history.slice(context.input.history.length);
      return context.outcome === 'failed'
        ? { type: 'failed', failure: context.failure ?? { reason: 'error' }, produced }
        : context.outcome === 'aborted'
          ? { type: 'aborted', produced }
          : { type: 'done', produced };
    },
  });
}
