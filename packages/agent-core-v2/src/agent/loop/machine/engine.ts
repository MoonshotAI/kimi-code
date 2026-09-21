import type { IAgentLLMRequesterService, AgentLLMRequestFinish, AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import type { ToolInfo, ToolResult as AgentToolResult, ToolUpdate as AgentToolUpdate } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { createAgentMachine, type PromptGate, type PromptGateVerdict } from '#human/agent/machine';
import { createTurnMachine, type AssistantEntry, type HistoryMessage, type SystemEntry, type UserEntry } from '#human/agent/turn';
import { messageAppended, turnEnded } from '#human/agent/events';
import { agentSlices, type AgentEventStore } from '#human/agent/slices';
import { credentialsRecovery } from '#human/credentials/credentials';
import { createEventStoreSync } from '#human/eventStore/eventStore';
import type { ExternalEvent } from '#human/eventStore/events';
import { memoryJournal, type SyncStoreJournal } from '#human/eventStore/journal';
import type { LlmErrorMessage } from '#human/llm/errors';
import type { FinishInfo } from '#human/llm/finish-reason';
import type { StreamedMessagePart } from '#human/llm/message';
import { UNKNOWN_CAPABILITY } from '#human/llm/capability';
import type { LlmModel } from '#human/llm/model';
import type { LlmRecovery, LlmRecoveryRecord } from '#human/llm/requester/recovery';
import type { LlmCredentialProvider, LlmRequestConfig } from '#human/llm/requester/requester';
import { resolveMaxAttempts } from '#human/llm/requester/retry';
import type { ToolResult as MachineToolResult, ToolUpdate } from '#human/tool/executor';
import { createToolMachine } from '#human/tool/machine';
import type { ToolDefinition } from '#human/tool/tool';
import { emptyUsage, type TokenUsage } from '#human/llm/usage';
import type { Actor, Subscription } from '#human/xstate2';

import { createMachineRequester, type MachineRequester, type MachineRequesterGateDecision } from './requester';
import { createMachineTools, type MachineTools, type ToolResultExtras } from './tools';
import { appendedStoreJournal, seededStoreJournal } from './storeJournal';

export type { PromptGateVerdict };

export type MachineEngineDelta =
  | { readonly kind: 'assistant'; readonly delta: string }
  | {
      readonly kind: 'thinking';
      readonly delta: string;
      readonly encrypted?: string;
      readonly detailsIndex?: number;
      readonly hidden?: boolean;
      readonly reasoningKey?: string;
    }
  | {
      readonly kind: 'toolCall';
      readonly toolCallId: string;
      readonly name: string;
      readonly argumentsPart?: string;
      readonly started?: boolean;
    };

export type MachineTurnOutcome = 'done' | 'failed' | 'aborted';

export type MachineEngineEvent =
  | { readonly type: 'turnStarted'; readonly machineTurnId: number; readonly queueItemId?: string; readonly entry?: UserEntry }
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
      readonly display?: ToolInputDisplay;
    }
  | { readonly type: 'toolUpdate'; readonly toolCallId: string; readonly update: ToolUpdate }
  | { readonly type: 'toolAsync'; readonly toolCallId: string; readonly text: string }
  | { readonly type: 'toolDone'; readonly toolCallId: string; readonly result: MachineToolResult }
  | { readonly type: 'toolFailed'; readonly toolCallId: string; readonly error: unknown }
  | { readonly type: 'toolAborted'; readonly toolCallId: string }
  | { readonly type: 'toolBatchFailed'; readonly error: unknown }
  | { readonly type: 'remindersConsumed'; readonly reminders: HistoryMessage[] }
  | { readonly type: 'promptBlocked'; readonly queueItemId?: string; readonly entry?: UserEntry }
  | { readonly type: 'promptGateFailed'; readonly queueItemId?: string; readonly error: unknown; readonly entry?: UserEntry }
  | { readonly type: 'promptSteered'; readonly queueItemIds: readonly string[]; readonly entries: readonly UserEntry[] }
  | { readonly type: 'aborting' };

export interface CreateMachineEngineOptions {
  readonly model: LlmModel;
  readonly systemPrompt?: string;
  readonly llmRequester: IAgentLLMRequesterService;
  readonly toolExecutor: IAgentToolExecutorService;
  readonly toolInfos: () => readonly ToolInfo[];
  readonly maxAttemptsPerStep?: number;
  readonly recovery?: LlmRecovery;
  readonly abortTimeoutMs?: number;
  readonly initialTurnId?: number;
  readonly journal?: SyncStoreJournal;
  readonly trace?: () => LLMRequestTrace | undefined;
  readonly source?: () => AgentLLMRequestSource | undefined;
  readonly toolTurnId?: () => number | undefined;
  readonly steerSignal?: () => AbortSignal | undefined;
  readonly gate?: (signal: AbortSignal) => Promise<MachineRequesterGateDecision>;
  readonly promptGate?: PromptGate;
  readonly onTrace?: (trace: LLMRequestTrace) => void;
  readonly onEvent?: (event: MachineEngineEvent) => void;
  readonly onToolResult?: (toolCallId: string, result: AgentToolResult) => void;
}

export interface MachineEngineRetrySnapshot {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

export interface MachineEngineToolCallSnapshot {
  readonly toolCallId: string;
  readonly name: string;
}

export interface MachineEngineTurnSnapshot {
  readonly turnId: number;
  readonly phase: 'running' | 'tool_call' | 'retrying';
  readonly step: number;
  readonly retry?: MachineEngineRetrySnapshot;
  readonly activeToolCalls: readonly MachineEngineToolCallSnapshot[];
}

export interface MachineEngineSnapshot {
  readonly running: boolean;
  readonly aborting: boolean;
  readonly waitingForBackground: boolean;
  readonly paused: boolean;
  readonly queue: readonly UserEntry[];
  readonly queueLength: number;
  readonly queueIds: readonly (string | undefined)[];
  readonly notificationCount: number;
  readonly reminderCount: number;
  readonly backgroundCount: number;
  readonly turn?: MachineEngineTurnSnapshot;
}

export interface MachineEngine {
  submit(entry: UserEntry): void;
  steer(id: string | readonly string[]): void;
  notify(entry: UserEntry): void;
  remind(key: string, entry: SystemEntry | UserEntry): void;
  cancelQueueItem(id: string): void;
  abort(reason?: unknown): void;
  pause(): void;
  resume(): void;
  resetHistory(history: readonly HistoryMessage[]): Promise<void>;
  resetJournal(journal: SyncStoreJournal): Promise<void>;
  stop(): void;
  snapshot(): MachineEngineSnapshot;
  currentStep(): number;
  lastFinish(): AgentLLMRequestFinish | undefined;
  readonly toolExtras: ReadonlyMap<string, ToolResultExtras>;
  handleToolProgress(toolCallId: string, update: AgentToolUpdate): void;
}

interface TurnSnapshotLike {
  readonly value: unknown;
  readonly context: {
    readonly steps: number;
    readonly attempt: number;
    readonly delayMs: number;
    readonly pendingToolCalls: readonly { readonly id: string; readonly name: string }[];
    readonly outcomes: Record<string, unknown>;
  };
}

interface MachineSnapshotLike {
  readonly value: unknown;
  readonly children: Record<string, { getSnapshot(): TurnSnapshotLike } | undefined>;
  readonly context: {
    readonly turnId: number;
    readonly queue: readonly UserEntry[];
    readonly notifications: readonly unknown[];
    readonly reminders: readonly unknown[];
    readonly background: Record<string, unknown>;
    readonly paused: boolean;
  };
}

function createDeltaSplitter(): (part: StreamedMessagePart) => MachineEngineDelta | undefined {
  const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();
  return (part) => {
    switch (part.type) {
      case 'text':
        return { kind: 'assistant', delta: part.text };
      case 'think':
        return {
          kind: 'thinking',
          delta: part.think,
          encrypted: part.encrypted,
          detailsIndex: part.detailsIndex,
          hidden: part.hidden,
          reasoningKey: part.reasoningKey,
        };
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

export type MachineEngineAttachRef = Pick<
  Actor<ReturnType<typeof createAgentMachine>>,
  'on' | 'send' | 'getSnapshot'
>;

export const MACHINE_LOOP_MODEL: LlmModel = {
  provider: 'agent-loop',
  model: 'agent-loop',
  capability: UNKNOWN_CAPABILITY,
};

export interface MachineEngineAttachBundle {
  readonly store: AgentEventStore;
  readonly turnLogic: ReturnType<typeof createTurnMachine>;
  readonly toolLogic: ReturnType<typeof createToolMachine>;
  readonly tools: ToolDefinition[];
  readonly request: LlmRequestConfig;
  readonly requester: MachineRequester;
  readonly machineTools: MachineTools;
  readonly promptGate?: PromptGate;
}

export function machineEngineAttachBundle(options: CreateMachineEngineOptions): MachineEngineAttachBundle {
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
    steerSignal: options.steerSignal,
    trace: options.trace,
    onToolCall: (payload) => {
      publish({
        type: 'toolStarted',
        toolCallId: payload.toolCallId,
        name: payload.name,
        args: payload.args,
        display: payload.display,
      });
    },
    onToolResult: options.onToolResult,
    onBatchError: (error) => {
      publish({ type: 'toolBatchFailed', error });
    },
  });
  const current = (): LlmCredentialProvider | undefined => {
    const source = options.source?.();
    return source?.type === 'turn'
      ? options.llmRequester.credentialProviderForTurn(source.turnId)
      : options.llmRequester.currentCredentialProvider();
  };
  const credentialProvider: LlmCredentialProvider = {
    resolve: () => current()?.resolve(),
    canRecover: (error) => current()?.canRecover?.(error) === true,
    invalidate: () => current()?.invalidate?.(),
  };
  const baseJournal = options.journal;
  const initialTurnId = options.initialTurnId ?? 0;
  const journal = engineJournal(baseJournal, initialTurnId);
  const store: AgentEventStore = createEventStoreSync({ journal, slices: agentSlices });
  tools.sync();
  return {
    store,
    turnLogic: createTurnMachine(requester.requester, {
      retry: { maxAttemptsPerStep: options.maxAttemptsPerStep },
      recovery: {
        propose: (ctx) => credentialsRecovery.propose(ctx) ?? options.recovery?.propose(ctx),
      },
    }),
    toolLogic: createToolMachine(tools.executor),
    tools: tools.tools,
    request: { model: options.model, systemPrompt: options.systemPrompt, credentialProvider },
    requester,
    machineTools: tools,
    promptGate: options.promptGate,
  };
}

export function attachMachineEngine(
  ref: MachineEngineAttachRef,
  bundle: MachineEngineAttachBundle,
  options: CreateMachineEngineOptions,
): MachineEngine {
  let currentStep = 0;
  let split = createDeltaSplitter();
  let pendingFailure: { step: number; error: LlmErrorMessage } | undefined;
  let lastRetry: MachineEngineRetrySnapshot | undefined;

  const publish = (event: MachineEngineEvent): void => {
    options.onEvent?.(event);
  };
  const store = bundle.store;
  const requester = bundle.requester;
  const tools = bundle.machineTools;
  let currentJournal = options.journal;
  const subscriptions: Subscription[] = [
    ref.on('turn.started', (event) => {
      currentStep = 0;
      split = createDeltaSplitter();
      pendingFailure = undefined;
      lastRetry = undefined;
      publish({ type: 'turnStarted', machineTurnId: event.turnId, queueItemId: event.queueItemId, entry: event.entry });
    }),
    ref.on('step.started', (event) => {
      currentStep = event.step;
    }),
    ref.on('llm.sent', (event) => {
      split = createDeltaSplitter();
      lastRetry = undefined;
      tools.beginBatch();
      publish({ type: 'stepStarted', step: currentStep, recovery: event.recovery });
    }),
    ref.on('llm.streaming.part', (event) => {
      const delta = split(event.part);
      if (delta !== undefined) publish({ type: 'delta', delta });
    }),
    ref.on('llm.retrying', (event) => {
      pendingFailure = undefined;
      lastRetry = {
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        statusCode: event.statusCode,
      };
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
    ref.on('llm.recovering', (event) => {
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
    ref.on('llm.done', (event) => {
      pendingFailure = undefined;
      lastRetry = undefined;
      tools.beginBatch(event.entry.message.toolCalls);
      const finish = requester.lastFinish();
      const meta = event.entry.meta;
      publish({
        type: 'stepCompleted',
        step: currentStep,
        entry: event.entry,
        usage: finish?.usage ?? meta?.usage ?? emptyUsage(),
        finish:
          finish !== undefined
            ? {
                finishReason: finish.providerFinishReason ?? null,
                rawFinishReason: finish.rawFinishReason ?? null,
              }
            : meta?.finish,
        messageId: finish?.providerMessageId ?? meta?.messageId,
        model: finish?.model ?? meta?.model?.model,
        timing: finish?.timing,
        traceId: finish?.traceId,
      });
    }),
    ref.on('llm.failed.syntax', (event) => {
      pendingFailure = { step: currentStep, error: event.error };
    }),
    ref.on('llm.failed.remote', (event) => {
      pendingFailure = { step: currentStep, error: event.error };
    }),
    ref.on('tool.update', (event) => {
      publish({ type: 'toolUpdate', toolCallId: event.toolCallId, update: event.update });
    }),
    ref.on('tool.detached', (event) => {
      publish({ type: 'toolAsync', toolCallId: event.toolCallId, text: event.text });
    }),
    ref.on('tool.done', (event) => {
      publish({ type: 'toolDone', toolCallId: event.toolCallId, result: event.result });
    }),
    ref.on('tool.failed', (event) => {
      publish({ type: 'toolFailed', toolCallId: event.toolCallId, error: event.error });
    }),
    ref.on('tool.aborted', (event) => {
      publish({ type: 'toolAborted', toolCallId: event.toolCallId });
    }),
    ref.on('turn.reminders_consumed', (event) => {
      publish({ type: 'remindersConsumed', reminders: event.reminders });
    }),
    ref.on('prompt.blocked', (event) => {
      publish({ type: 'promptBlocked', queueItemId: event.queueItemId, entry: event.entry });
    }),
    ref.on('prompt.gate_failed', (event) => {
      publish({ type: 'promptGateFailed', queueItemId: event.queueItemId, error: event.error, entry: event.entry });
    }),
    ref.on('prompt.steered', (event) => {
      publish({ type: 'promptSteered', queueItemIds: event.queueItemIds, entries: event.entries });
    }),
    ref.on('turn.aborting', () => {
      publish({ type: 'aborting' });
    }),
    ref.on('turn.done', (event) => {
      publish({ type: 'turnSettled', outcome: 'done', produced: event.messages });
    }),
    ref.on('turn.failed', (event) => {
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
    ref.on('turn.aborted', (event) => {
      publish({ type: 'turnSettled', outcome: 'aborted', produced: event.messages });
    }),
  ];

  return {
    submit: (entry) => {
      tools.sync();
      ref.send({ type: 'input.submit', entry });
    },
    steer: (id) => {
      tools.sync();
      ref.send({ type: 'input.steer', id });
    },
    notify: (entry) => {
      tools.sync();
      ref.send({ type: 'input.notify', entry });
    },
    remind: (key, entry) => {
      tools.sync();
      ref.send({ type: 'input.remind', key, entry });
    },
    cancelQueueItem: (id) => {
      ref.send({ type: 'input.cancel', id });
    },
    abort: (reason) => {
      ref.send({ type: 'input.abort', reason });
    },
    pause: () => {
      ref.send({ type: 'input.pause' });
    },
    resume: () => {
      ref.send({ type: 'input.continue' });
    },
    resetHistory: (history) => {
      const events: ExternalEvent[] = history.map((message) => messageAppended({ message }));
      const nextTurnId = (ref.getSnapshot() as unknown as MachineSnapshotLike).context.turnId;
      if (nextTurnId > 0) {
        events.push(turnEnded({ turnId: nextTurnId - 1, outcome: 'done' }));
      }
      const seed = seedRecords(events);
      const next = currentJournal === undefined ? seed : seededStoreJournal(currentJournal, seed.readSync());
      return store.reset(next);
    },
    resetJournal: (journal) => {
      currentJournal = journal;
      return store.reset(journal);
    },
    stop: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    },
    snapshot: () => {
      const snapshot = ref.getSnapshot() as unknown as MachineSnapshotLike;
      const value = snapshot.value;
      const turnRef = snapshot.children['turn'];
      let turn: MachineEngineTurnSnapshot | undefined;
      if (turnRef !== undefined) {
        const turnSnapshot = turnRef.getSnapshot();
        const turnValue = turnSnapshot.value;
        const phase =
          turnValue === 'retrying'
            ? ('retrying' as const)
            : typeof turnValue === 'object' && turnValue !== null && 'acting' in turnValue
              ? ('tool_call' as const)
              : ('running' as const);
        const context = turnSnapshot.context;
        turn = {
          turnId: snapshot.context.turnId,
          phase,
          step: context.steps,
          retry:
            phase === 'retrying'
              ? (lastRetry ?? {
                  failedAttempt: context.attempt - 1,
                  nextAttempt: context.attempt,
                  maxAttempts: resolveMaxAttempts({ maxAttemptsPerStep: options.maxAttemptsPerStep }),
                  delayMs: context.delayMs,
                })
              : undefined,
          activeToolCalls: context.pendingToolCalls
            .filter((toolCall) => context.outcomes[toolCall.id] === undefined)
            .map((toolCall) => ({ toolCallId: toolCall.id, name: toolCall.name })),
        };
      }
      return {
        running: value === 'running' || (typeof value === 'object' && value !== null && 'running' in value),
        aborting: typeof value === 'object' && value !== null && 'running' in value &&
          (value as { running?: unknown }).running === 'aborting',
        waitingForBackground:
          typeof value === 'object' && value !== null && 'idle' in value &&
          (value as { idle?: unknown }).idle === 'waiting',
        paused: snapshot.context.paused,
        queue: snapshot.context.queue,
        queueLength: snapshot.context.queue.length,
        queueIds: snapshot.context.queue.map((entry) => entry.meta?.promptId),
        notificationCount: snapshot.context.notifications.length,
        reminderCount: snapshot.context.reminders.length,
        backgroundCount: Object.keys(snapshot.context.background).length,
        turn,
      };
    },
    lastFinish: () => requester.lastFinish(),
    currentStep: () => currentStep,
    toolExtras: tools.extras,
    handleToolProgress: (toolCallId, update) => {
      tools.handleProgress(toolCallId, update);
    },
  };
}

function seedRecords(events: readonly ExternalEvent[]): SyncStoreJournal {
  const journal = memoryJournal();
  for (const event of events) {
    void journal.append({ type: event.type, kind: 'event', data: event });
  }
  return journal;
}

export function engineJournal(base: SyncStoreJournal | undefined, initialTurnId: number): SyncStoreJournal {
  if (base === undefined) {
    if (initialTurnId <= 0) return memoryJournal();
    return seedRecords([turnEnded({ turnId: initialTurnId - 1, outcome: 'done' })]);
  }
  if (initialTurnId <= 0) return base;
  const seed = seedRecords([turnEnded({ turnId: initialTurnId - 1, outcome: 'done' })]).readSync();
  if (base.readSync().length === 0) return seededStoreJournal(base, seed);
  return appendedStoreJournal(base, seed);
}
