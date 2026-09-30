import { assign, fromPromise, setup } from '#/xstate2/index';

import { createToolMessage, type ToolCall, type ToolDescription } from '#/llm/message';
import {
  createAssistantEntry,
  createToolEntry,
  toRequestMessages,
  type AssistantEntry,
  type HistoryMessage,
  type ToolEntry,
} from '#/history/message';
import { usedContextTokens } from '#/history/usage';
import type { LlmEndpoint, LlmModelSpec, LlmRequestModel } from '#/llm/request';
import type { LlmOutcome, LlmOutput, LlmRunEvent } from '#/llm/response';
import { createRequestActor } from './llm-actor';
import type { ToolBeforeDecision, ToolOutput } from './tool';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';

function modelMeta(model: LlmModelSpec): { model: { provider: string; model: string } } {
  return { model: { provider: model.provider, model: model.name } };
}

export interface TurnInput {
  history: readonly HistoryMessage[];
  maxSteps?: number;
  parentSignal?: AbortSignal;
}

export type TurnToolEvent =
  | { type: 'tool.detached'; toolCallId: string; text: string; toolCall: ToolCall }
  | { type: 'tool.done'; toolCallId: string; outcome: ToolOutput };

export type TurnEvent =
  | LlmRunEvent
  | TurnToolEvent
  | { type: 'agent.notify'; messages: HistoryMessage[] }
  | { type: 'turn.compaction_finished'; history?: HistoryMessage[]; error?: unknown }
  | { type: 'turn.pause' }
  | { type: 'turn.continue' }
  | { type: 'turn.abort'; reason?: unknown };

export type TurnLlmEvent =
  | Exclude<LlmRunEvent, { type: 'llm.ended' }>
  | { type: 'llm.done'; entry: AssistantEntry }
  | { type: 'llm.ended'; outcome: Extract<LlmOutcome, { type: 'aborted' | 'failed' }> };

export type TurnCompactionReason = 'budget' | 'overflow';

export type TurnSignal =
  | { type: 'step.started'; step: number }
  | {
      type: 'turn.spawn_tools';
      toolCalls: ToolCall[];
      decisions?: Record<string, ToolBeforeDecision>;
    }
  | { type: 'turn.compaction_requested'; reason: TurnCompactionReason; history: HistoryMessage[] }
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

export type TurnOutcome =
  | { type: 'done' }
  | { type: 'failed'; failure: TurnFailure }
  | { type: 'aborted'; reason?: unknown };

export type TurnOutput = TurnOutcome & { produced: HistoryMessage[] };

export interface TurnMachineContext {
  input: TurnInput;
  history: HistoryMessage[];
  produced: HistoryMessage[];
  llmScope: AbortScope;
  pendingToolCalls: ToolCall[];
  outcomes: Record<string, ToolOutput>;
  toolDecisions?: Record<string, ToolBeforeDecision>;
  toolStopTurn?: boolean;
  steps: number;
  step: number;
  paused: boolean;
  compactReason?: TurnCompactionReason;
  outcome?: 'done' | 'failed' | 'aborted';
  failure?: TurnFailure;
}

function assistantEntry(
  context: TurnMachineContext,
  output: LlmOutput,
  source: string,
  model?: LlmModelSpec,
): AssistantEntry {
  return createAssistantEntry(output.message, {
    source,
    ...(model === undefined ? {} : modelMeta(model)),
    usage: output.usage,
    headers: output.headers,
    finish: output.finish,
    messageId: output.messageId,
  });
}

function toolOutcomeEntry(toolCall: ToolCall, output: ToolOutput): ToolEntry {
  if (output.type === 'failed') {
    const text = output.error instanceof Error ? output.error.message : String(output.error);
    return createToolEntry(createToolMessage(toolCall.id, text), { source: 'tool', isError: true });
  }
  if (output.type === 'aborted') {
    return createToolEntry(createToolMessage(toolCall.id, 'aborted'), {
      source: 'tool',
      isError: true,
    });
  }
  return createToolEntry(createToolMessage(toolCall.id, output.result.content), {
    source: 'tool',
    isError: output.result.isError === true ? true : undefined,
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

function toolStopTurnRequested(context: TurnMachineContext): boolean {
  return context.pendingToolCalls.some((toolCall) => {
    const outcome = context.outcomes[toolCall.id];
    return outcome?.type === 'succeeded' && outcome.result.stopTurn === true;
  });
}

function collectToolOutcomes(
  context: TurnMachineContext,
): Pick<
  TurnMachineContext,
  'history' | 'produced' | 'pendingToolCalls' | 'outcomes' | 'toolDecisions' | 'toolStopTurn'
> {
  const entries = context.pendingToolCalls.map((toolCall) =>
    toolOutcomeEntry(toolCall, context.outcomes[toolCall.id] as ToolOutput),
  );
  return {
    history: [...context.history, ...entries],
    produced: [...context.produced, ...entries],
    pendingToolCalls: [],
    outcomes: {},
    toolDecisions: undefined,
    toolStopTurn: toolStopTurnRequested(context),
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
  model?: LlmRequestModel;
  tools: readonly ToolDescription[];
  systemPrompt?: string;
}

export type TurnBeforeStepDecision = { readonly compact: true };

export type TurnBeforeStep = (
  context: TurnBeforeStepContext,
) => void | TurnBeforeStepDecision | Promise<void | TurnBeforeStepDecision>;

export interface TurnAfterStepContext {
  step: number;
  final: boolean;
  messages: readonly HistoryMessage[];
}

export interface TurnAfterStepDecision {
  readonly stopTurn?: boolean;
}

export type TurnAfterStep = (
  context: TurnAfterStepContext,
) => void | TurnAfterStepDecision | Promise<void | TurnAfterStepDecision>;

export interface TurnBeforeToolsInput {
  toolCalls: readonly ToolCall[];
}

export type TurnBeforeToolsDecisions = Record<string, ToolBeforeDecision>;

export type TurnBeforeTools = (
  input: TurnBeforeToolsInput,
) => TurnBeforeToolsDecisions | Promise<TurnBeforeToolsDecisions>;

export type LlmActorLogic = ReturnType<typeof createRequestActor>;

export interface CreateTurnMachineOptions {
  readonly abortGraceMs?: number;
  readonly getTools?: () => readonly ToolDescription[] | undefined;
  readonly getSystemPrompt?: (host?: string) => string | undefined;
  readonly getHostPrompt?: () => string | undefined;
  readonly getModel?: () => LlmRequestModel | undefined;
  readonly getEndpoint?: () => LlmEndpoint | undefined;
  readonly onBeforeStep?: TurnBeforeStep;
  readonly onAfterStep?: TurnAfterStep;
  readonly onBeforeTools?: TurnBeforeTools;
}

export type TurnLogic = ReturnType<typeof createTurnMachine>;

export function createTurnMachine(
  llmActor: LlmActorLogic,
  options?: CreateTurnMachineOptions,
) {
  const abortGraceMs = options?.abortGraceMs ?? 2_500;
  const toolsFor = (): readonly ToolDescription[] | undefined => options?.getTools?.();
  const modelOf = (): LlmRequestModel | undefined => options?.getModel?.();
  const systemPromptFor = (): string | undefined => {
    const host = options?.getHostPrompt?.();
    return options?.getSystemPrompt === undefined ? host : options.getSystemPrompt(host);
  };
  return setup({
    types: {
      input: {} as TurnInput,
      context: {} as TurnMachineContext,
      events: {} as TurnEvent,
      output: {} as TurnOutput,
    },
    actors: {
      llmActor,
      onBeforeStepActor: fromPromise<TurnBeforeStepDecision | undefined, TurnBeforeStepContext>(
        async ({ input }) => (await options?.onBeforeStep?.(input)) ?? undefined,
      ),
      onAfterStepActor: fromPromise<TurnAfterStepDecision | undefined, TurnAfterStepContext>(
        async ({ input }) => (await options?.onAfterStep?.(input)) ?? undefined,
      ),
      onBeforeToolsActor: fromPromise<TurnBeforeToolsDecisions, TurnBeforeToolsInput>(
        async ({ input }) => (await options?.onBeforeTools?.(input)) ?? {},
      ),
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
    context: ({ input }) => ({
      input,
      history: [...input.history],
      produced: [],
      llmScope: createAbortScope(),
      pendingToolCalls: [],
      outcomes: {},
      steps: 1,
      step: 0,
      paused: false,
    }),
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
            const model = modelOf();
            return {
              messages: context.history,
              model,
              tools: toolsFor() ?? [],
              systemPrompt: systemPromptFor(),
            };
          },
          onDone: [
            {
              guard: ({ event }) => event.output?.compact === true,
              target: 'compacting',
              actions: assign({ compactReason: 'budget' as const }),
            },
            { target: 'streaming' },
          ],
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
                const model = modelOf();
                if (model === undefined) {
                  throw new Error('model is not set');
                }
                const tools = toolsFor();
                const systemPrompt = systemPromptFor();
                return {
                  rest: {
                    model,
                    endpoint: options?.getEndpoint?.(),
                    profile: {
                      systemPrompt,
                      tools,
                    },
                    content: {
                      messages: toRequestMessages(context.history),
                      usedTokens: usedContextTokens(context.history, { systemPrompt, tools }),
                    },
                  },
                  signal: context.llmScope.signal,
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
              'llm.started': {
                actions: [
                  {
                    type: 'sendToParent',
                    params: { type: 'llm.started' as const },
                  },
                ],
              },
              'llm.notice': { actions: 'forwardToParent' },
              'llm.streaming.headers': { actions: 'forwardToParent' },
              'llm.streaming.part': { actions: 'forwardToParent' },
              'llm.streaming.usage': { actions: 'forwardToParent' },
              'llm.streaming.finish': { actions: 'forwardToParent' },
              'llm.streaming.message_id': { actions: 'forwardToParent' },
              'llm.retrying': { actions: 'forwardToParent' },
              'llm.ended': [
                {
                  guard: ({ event }) =>
                    event.outcome.type === 'done' && event.outcome.message.toolCalls.length > 0,
                  target: '#turn.preparingTools',
                  actions: [
                    assign(({ context, event }) => {
                      const outcome = event.outcome as Extract<typeof event.outcome, { type: 'done' }>;
                      const entry = assistantEntry(context, outcome, 'llm', modelOf()?.spec);
                      return {
                        history: [...context.history, entry],
                        produced: [...context.produced, entry],
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
                  guard: ({ event }) =>
                    event.outcome.type === 'done' && options?.onAfterStep === undefined,
                  target: '#turn.done',
                  actions: [
                    assign(({ context, event }) => {
                      const outcome = event.outcome as Extract<typeof event.outcome, { type: 'done' }>;
                      const entry = assistantEntry(context, outcome, 'llm', modelOf()?.spec);
                      return {
                        history: [...context.history, entry],
                        produced: [...context.produced, entry],
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
                  guard: ({ event }) => event.outcome.type === 'done',
                  target: '#turn.settling',
                  actions: [
                    assign(({ context, event }) => {
                      const outcome = event.outcome as Extract<typeof event.outcome, { type: 'done' }>;
                      const entry = assistantEntry(context, outcome, 'llm', modelOf()?.spec);
                      return {
                        outcome: 'done' as const,
                        history: [...context.history, entry],
                        produced: [...context.produced, entry],
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
                  guard: ({ event }) => event.outcome.type === 'aborted',
                  target: '#turn.aborted',
                  actions: [
                    'forwardToParent',
                    assign(({ context, event }) => {
                      const outcome = event.outcome as Extract<typeof event.outcome, { type: 'aborted' }>;
                      const message = outcome.message;
                      if (message === null) {
                        return { outcome: 'aborted' as const };
                      }
                      const entry = assistantEntry(
                        context,
                        { ...outcome, message },
                        'salvaged',
                        modelOf()?.spec,
                      );
                      return {
                        outcome: 'aborted' as const,
                        history: [...context.history, entry],
                        produced: [...context.produced, entry],
                      };
                    }),
                  ],
                },
                {
                  guard: ({ event }) =>
                    event.outcome.type === 'failed' && event.outcome.error.kind === 'syntax',
                  target: '#turn.failed',
                  actions: [
                    'forwardToParent',
                    assign({
                      outcome: 'failed' as const,
                      failure: ({ event }) => ({
                        reason: 'error' as const,
                        error:
                          event.outcome.type === 'failed' ? event.outcome.error : event.outcome,
                      }),
                    }),
                  ],
                },
                {
                  guard: ({ event }) =>
                    event.outcome.type === 'failed' &&
                    event.outcome.error.kind === 'context_overflow',
                  target: '#turn.compacting',
                  actions: assign({ compactReason: 'overflow' as const }),
                },
                {
                  target: '#turn.failed',
                  actions: [
                    'forwardToParent',
                    assign({
                      outcome: 'failed' as const,
                      failure: ({ event }) => ({
                        reason: 'error' as const,
                        error:
                          event.outcome.type === 'failed'
                            ? (event.outcome.rawError ?? event.outcome.error)
                            : event.outcome,
                      }),
                    }),
                  ],
                },
              ],
            },
          },
        },
      },
      preparingTools: {
        always: [{ guard: () => options?.onBeforeTools === undefined, target: 'acting' }],
        invoke: {
          src: 'onBeforeToolsActor',
          input: ({ context }) => ({ toolCalls: context.pendingToolCalls }),
          onDone: {
            target: 'acting',
            actions: assign({
              toolDecisions: ({ event }) => event.output,
            }),
          },
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
            actions: [assign({ outcome: 'aborted' as const }), 'collectAborted'],
          },
        },
      },
      acting: {
        entry: {
          type: 'signalParent',
          params: ({ context }) => ({
            type: 'turn.spawn_tools' as const,
            toolCalls: context.pendingToolCalls,
            decisions: context.toolDecisions,
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
              options?.onAfterStep === undefined &&
              !toolStopTurnRequested(context) &&
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'draining',
            actions: assign(({ context }) => collectToolOutcomes(context)),
          },
          {
            guard: ({ context }) =>
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'settling',
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
                [event.toolCallId]: event.outcome,
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
      settling: {
        invoke: {
          src: 'onAfterStepActor',
          input: ({ context }) => ({
            step: context.step,
            final: context.outcome === 'done',
            messages: context.history,
          }),
          onDone: [
            {
              guard: ({ context }) => context.outcome === 'done',
              target: 'done',
            },
            {
              guard: ({ context, event }) =>
                event.output?.stopTurn === true || context.toolStopTurn === true,
              target: 'done',
            },
            { target: 'draining' },
          ],
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
                produced: [...context.produced, ...event.messages],
              })),
            },
            {
              guard: ({ context }) => maxStepsExceeded(context),
              target: 'failed',
              actions: assign(({ context, event }) => ({
                history: [...context.history, ...event.messages],
                produced: [...context.produced, ...event.messages],
                outcome: 'failed' as const,
                failure: createMaxStepsExceeded(context.input.maxSteps as number),
              })),
            },
            {
              target: 'gating',
              actions: assign(({ context, event }) => ({
                history: [...context.history, ...event.messages],
                produced: [...context.produced, ...event.messages],
                steps: context.steps + 1,
              })),
            },
          ],
          'turn.abort': {
            target: 'aborted',
            actions: assign({ outcome: 'aborted' as const }),
          },
        },
      },
      compacting: {
        entry: {
          type: 'signalParent',
          params: ({ context }) => ({
            type: 'turn.compaction_requested' as const,
            reason: context.compactReason ?? 'budget',
            history: context.history,
          }),
        },
        on: {
          'turn.compaction_finished': [
            {
              guard: ({ event }) => event.history !== undefined,
              target: 'gating',
              actions: assign(({ event }) => {
                const history = event.history as HistoryMessage[];
                return {
                  history: [...history],
                  produced: [],
                };
              }),
            },
            {
              target: 'failed',
              actions: assign({
                outcome: 'failed' as const,
                failure: ({ event }) => ({
                  reason: 'error' as const,
                  error: event.type === 'turn.compaction_finished' ? event.error : undefined,
                }),
              }),
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
      const produced = context.produced;
      return context.outcome === 'failed'
        ? { type: 'failed', failure: context.failure ?? { reason: 'error' }, produced }
        : context.outcome === 'aborted'
          ? { type: 'aborted', produced }
          : { type: 'done', produced };
    },
  });
}
