import type { IAgentLLMRequesterService, AgentLLMRequestFinish, AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import type { ToolInfo, ToolResult as AgentToolResult, ToolUpdate as AgentToolUpdate } from '#/tool/toolContract';
import { createAgentMachine } from '#human/agent/machine';
import { createTurnMachine, type AssistantEntry, type HistoryMessage } from '#human/agent/turn';
import type { LlmErrorMessage } from '#human/llm/errors';
import type { FinishInfo } from '#human/llm/finish-reason';
import type { StreamedMessagePart, UserMessage } from '#human/llm/message';
import type { LlmModel } from '#human/llm/model';
import { createLlmMachine } from '#human/llm/requester/machine';
import type { LlmRecovery, LlmRecoveryRecord } from '#human/llm/requester/recovery';
import type { ToolResult as MachineToolResult, ToolUpdate } from '#human/tool/executor';
import type { TokenUsage } from '#human/llm/usage';
import { createActor, type Subscription } from '#human/xstate2';

import { createMachineRequester, type MachineRequesterGateDecision } from './requester';
import { createMachineTools, type ToolResultExtras } from './tools';

export type MachineEngineDelta =
  | { readonly kind: 'assistant'; readonly delta: string }
  | { readonly kind: 'thinking'; readonly delta: string }
  | {
      readonly kind: 'toolCall';
      readonly toolCallId: string;
      readonly name: string;
      readonly argumentsPart?: string;
      readonly started?: boolean;
    };

export type MachineTurnOutcome = 'done' | 'failed' | 'aborted';

export type MachineEngineEvent =
  | { readonly type: 'turnStarted'; readonly machineTurnId: number }
  | {
      readonly type: 'turnSettled';
      readonly outcome: MachineTurnOutcome;
      readonly error?: unknown;
      readonly produced: readonly HistoryMessage[];
    }
  | { readonly type: 'stepStarted'; readonly step: number; readonly recovery?: LlmRecoveryRecord }
  | {
      readonly type: 'stepCompleted';
      readonly step: number;
      readonly entry: AssistantEntry;
      readonly usage: TokenUsage;
      readonly finish?: FinishInfo;
      readonly messageId?: string;
      readonly model?: string;
      readonly timing?: ModelRequestTiming;
      readonly traceId?: string;
    }
  | { readonly type: 'stepFailed'; readonly step: number; readonly error: LlmErrorMessage; readonly rawError?: unknown }
  | { readonly type: 'delta'; readonly delta: MachineEngineDelta }
  | {
      readonly type: 'retrying';
      readonly step: number;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName: string;
      readonly errorMessage: string;
      readonly statusCode?: number;
      readonly rawError?: unknown;
    }
  | {
      readonly type: 'recovering';
      readonly step: number;
      readonly strategy: string;
      readonly action: string;
      readonly errorName: string;
      readonly errorMessage: string;
      readonly statusCode?: number;
    }
  | {
      readonly type: 'toolStarted';
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly type: 'toolUpdate'; readonly toolCallId: string; readonly update: ToolUpdate }
  | { readonly type: 'toolAsync'; readonly toolCallId: string; readonly text: string }
  | { readonly type: 'toolDone'; readonly toolCallId: string; readonly result: MachineToolResult }
  | { readonly type: 'toolFailed'; readonly toolCallId: string; readonly error: unknown }
  | { readonly type: 'toolAborted'; readonly toolCallId: string }
  | { readonly type: 'toolBatchFailed'; readonly error: unknown }
  | { readonly type: 'remindersConsumed'; readonly reminders: HistoryMessage[] }
  | { readonly type: 'aborting' };

export interface CreateMachineEngineOptions {
  readonly model: LlmModel;
  readonly systemPrompt?: string;
  readonly llmRequester: IAgentLLMRequesterService;
  readonly toolExecutor: IAgentToolExecutorService;
  readonly toolInfos: readonly ToolInfo[];
  readonly maxAttemptsPerStep?: number;
  readonly recovery?: LlmRecovery;
  readonly abortTimeoutMs?: number;
  readonly trace?: () => LLMRequestTrace | undefined;
  readonly source?: () => AgentLLMRequestSource | undefined;
  readonly toolTurnId?: () => number | undefined;
  readonly gate?: (signal: AbortSignal) => Promise<MachineRequesterGateDecision>;
  readonly onTrace?: (trace: LLMRequestTrace) => void;
  readonly onEvent?: (event: MachineEngineEvent) => void;
  readonly onToolResult?: (toolCallId: string, result: AgentToolResult) => void;
}

export interface MachineEngineSnapshot {
  readonly running: boolean;
  readonly aborting: boolean;
  readonly waitingForBackground: boolean;
  readonly queueLength: number;
  readonly queueIds: readonly (string | undefined)[];
  readonly notificationCount: number;
  readonly reminderCount: number;
  readonly backgroundCount: number;
}

export interface MachineEngine {
  submit(input: { readonly id?: string; readonly message: UserMessage }): void;
  steer(id: string): void;
  notify(message: UserMessage): void;
  remind(key: string, message: UserMessage): void;
  abort(): void;
  resetHistory(history: readonly HistoryMessage[], turnId: number): void;
  stop(): void;
  snapshot(): MachineEngineSnapshot;
  lastFinish(): AgentLLMRequestFinish | undefined;
  readonly toolExtras: ReadonlyMap<string, ToolResultExtras>;
  handleToolProgress(toolCallId: string, update: AgentToolUpdate): void;
}

interface MachineSnapshotLike {
  readonly value: unknown;
  readonly context: {
    readonly queue: readonly { readonly id?: string }[];
    readonly notifications: readonly unknown[];
    readonly reminders: readonly unknown[];
    readonly background: Record<string, unknown>;
  };
}

function createDeltaSplitter(): (part: StreamedMessagePart) => MachineEngineDelta | undefined {
  const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();
  return (part) => {
    switch (part.type) {
      case 'text':
        return { kind: 'assistant', delta: part.text };
      case 'think':
        return { kind: 'thinking', delta: part.think };
      case 'image_url':
      case 'audio_url':
      case 'video_url':
        return undefined;
      case 'function': {
        callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
        return {
          kind: 'toolCall',
          toolCallId: part.id,
          name: part.name,
          argumentsPart: part.arguments ?? undefined,
          started: true,
        };
      }
      case 'tool_call_part': {
        if (part.argumentsPart === null) return undefined;
        const call = callsByIndex.get(part.index);
        if (call === undefined) return undefined;
        return {
          kind: 'toolCall',
          toolCallId: call.id,
          name: call.name,
          argumentsPart: part.argumentsPart,
        };
      }
    }
  };
}

export function createMachineEngine(options: CreateMachineEngineOptions): MachineEngine {
  let currentStep = 0;
  let split = createDeltaSplitter();
  let pendingFailure: { step: number; error: LlmErrorMessage } | undefined;

  const publish = (event: MachineEngineEvent): void => {
    options.onEvent?.(event);
  };
  const requester = createMachineRequester(options.llmRequester, {
    source: options.source,
    gate: options.gate,
    onTrace: options.onTrace,
  });
  const tools = createMachineTools({
    toolExecutor: options.toolExecutor,
    toolInfos: options.toolInfos,
    turnId: () => options.toolTurnId?.() ?? 0,
    trace: options.trace,
    onToolCall: (payload) => {
      publish({
        type: 'toolStarted',
        toolCallId: payload.toolCallId,
        name: payload.name,
        args: payload.args,
      });
    },
    onToolResult: options.onToolResult,
    onBatchError: (error) => {
      publish({ type: 'toolBatchFailed', error });
    },
  });
  const actor = createActor(
    createAgentMachine({
      tools: tools.tools,
      turnActor: createTurnMachine(
        createLlmMachine({
          requester: requester.requester,
          retry: { maxAttemptsPerStep: options.maxAttemptsPerStep },
          recovery: options.recovery,
        }),
      ),
      abortTimeoutMs: options.abortTimeoutMs,
    }),
    { input: { request: { model: options.model, systemPrompt: options.systemPrompt } } },
  );
  const subscriptions: Subscription[] = [
    actor.on('turn.start', (event) => {
      currentStep = 0;
      split = createDeltaSplitter();
      pendingFailure = undefined;
      publish({ type: 'turnStarted', machineTurnId: event.turnId });
    }),
    actor.on('llm.sent', (event) => {
      currentStep += 1;
      split = createDeltaSplitter();
      tools.beginBatch();
      publish({ type: 'stepStarted', step: currentStep, recovery: event.recovery });
    }),
    actor.on('llm.delta', (event) => {
      const delta = split(event.part);
      if (delta !== undefined) publish({ type: 'delta', delta });
    }),
    actor.on('llm.retrying', (event) => {
      pendingFailure = undefined;
      publish({
        type: 'retrying',
        step: currentStep,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
        rawError: requester.lastError(),
      });
    }),
    actor.on('llm.recovering', (event) => {
      pendingFailure = undefined;
      publish({
        type: 'recovering',
        step: currentStep,
        strategy: event.strategy,
        action: event.action,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      });
    }),
    actor.on('llm.done', (event) => {
      pendingFailure = undefined;
      tools.beginBatch(event.entry.message.toolCalls);
      const finish = requester.lastFinish();
      const meta = event.entry.meta;
      publish({
        type: 'stepCompleted',
        step: currentStep,
        entry: event.entry,
        usage: finish?.usage ?? meta.usage,
        finish:
          finish !== undefined
            ? {
                finishReason: finish.providerFinishReason ?? null,
                rawFinishReason: finish.rawFinishReason ?? null,
              }
            : meta.finish,
        messageId: finish?.providerMessageId ?? meta.messageId,
        model: finish?.model ?? meta.model?.model,
        timing: finish?.timing,
        traceId: finish?.traceId,
      });
    }),
    actor.on('llm.failed.syntax', (event) => {
      pendingFailure = { step: currentStep, error: event.error };
    }),
    actor.on('llm.failed.remote', (event) => {
      pendingFailure = { step: currentStep, error: event.error };
    }),
    actor.on('tool.update', (event) => {
      publish({ type: 'toolUpdate', toolCallId: event.toolCallId, update: event.update });
    }),
    actor.on('tool.async', (event) => {
      publish({ type: 'toolAsync', toolCallId: event.toolCallId, text: event.text });
    }),
    actor.on('tool.done', (event) => {
      publish({ type: 'toolDone', toolCallId: event.toolCallId, result: event.result });
    }),
    actor.on('tool.failed', (event) => {
      publish({ type: 'toolFailed', toolCallId: event.toolCallId, error: event.error });
    }),
    actor.on('tool.aborted', (event) => {
      publish({ type: 'toolAborted', toolCallId: event.toolCallId });
    }),
    actor.on('turn.remindersConsumed', (event) => {
      publish({ type: 'remindersConsumed', reminders: event.reminders });
    }),
    actor.on('turn.aborting', () => {
      publish({ type: 'aborting' });
    }),
    actor.on('turn.done', (event) => {
      publish({ type: 'turnSettled', outcome: 'done', produced: event.messages });
    }),
    actor.on('turn.failed', (event) => {
      const failure = pendingFailure;
      if (failure !== undefined) {
        publish({
          type: 'stepFailed',
          step: failure.step,
          error: failure.error,
          rawError: requester.lastError(),
        });
      }
      publish({
        type: 'turnSettled',
        outcome: 'failed',
        error: event.error,
        produced: event.messages,
      });
    }),
    actor.on('turn.aborted', (event) => {
      publish({ type: 'turnSettled', outcome: 'aborted', produced: event.messages });
    }),
  ];
  actor.start();

  return {
    submit: (input) => {
      actor.send({ type: 'input.submit', id: input.id, message: input.message });
    },
    steer: (id) => {
      actor.send({ type: 'input.steer', id });
    },
    notify: (message) => {
      actor.send({ type: 'input.notify', message });
    },
    remind: (key, message) => {
      actor.send({ type: 'input.reminder', key, message });
    },
    abort: () => {
      actor.send({ type: 'input.abort' });
    },
    resetHistory: (history, turnId) => {
      actor.send({ type: 'context.reset', history, turnId });
    },
    stop: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      actor.stop();
    },
    snapshot: () => {
      const snapshot = actor.getSnapshot() as unknown as MachineSnapshotLike;
      const value = snapshot.value;
      return {
        running: value === 'running' || (typeof value === 'object' && value !== null && 'running' in value),
        aborting: typeof value === 'object' && value !== null && 'running' in value &&
          (value as { running?: unknown }).running === 'aborting',
        waitingForBackground:
          typeof value === 'object' && value !== null && 'idle' in value &&
          (value as { idle?: unknown }).idle === 'waiting',
        queueLength: snapshot.context.queue.length,
        queueIds: snapshot.context.queue.map((entry) => entry.id),
        notificationCount: snapshot.context.notifications.length,
        reminderCount: snapshot.context.reminders.length,
        backgroundCount: Object.keys(snapshot.context.background).length,
      };
    },
    lastFinish: () => requester.lastFinish(),
    toolExtras: tools.extras,
    handleToolProgress: (toolCallId, update) => {
      tools.handleProgress(toolCallId, update);
    },
  };
}
