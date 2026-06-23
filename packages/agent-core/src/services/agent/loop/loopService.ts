import {
  createToolMessage,
  emptyUsage,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type ContentPart,
  type StreamedMessagePart,
  type ToolCall as KosongToolCall,
} from '@moonshot-ai/kosong';

import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import {
  runTurn as runLoopTurn,
  type ExecutableTool,
  type ExecutableToolResult,
  type LoopStepEndEvent,
  type LLM,
  type LLMChatParams,
  type LLMChatResponse,
  type LoopHooks,
  type LoopEvent,
  type LoopEventDispatcher,
  type LoopRecordedEvent,
} from '../../../loop';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { IEventBus } from '../eventBus/eventBus';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { IProfileService } from '../profile/profile';
import { IToolExecutor } from '../toolExecutor/toolExecutor';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { ContextMessage, ToolDefinition, ToolResult, Turn, TurnResult } from '../types';
import { IUsageService } from '../usage/usage';
import { IWireRecord } from '../wireRecord/wireRecord';
import { ILoopService, type LoopRunHooks } from './loop';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

declare module '../types' {
  interface AgentEventMap {
    'turn.step.started': {
      turnId: number;
      step: number;
      stepId: string;
    };
    'turn.step.completed': {
      turnId: number;
      step: number;
      stepId: string;
      usage?: LoopStepEndEvent['usage'];
      finishReason?: LoopStepEndEvent['finishReason'];
      llmFirstTokenLatencyMs?: number;
      llmStreamDurationMs?: number;
      providerFinishReason?: LoopStepEndEvent['providerFinishReason'];
      rawFinishReason?: string;
    };
    'assistant.delta': {
      turnId: number;
      delta: string;
    };
    'thinking.delta': {
      turnId: number;
      delta: string;
    };
    'tool.call.delta': {
      turnId: number;
      toolCallId: string;
      name?: string;
      argumentsPart?: string;
    };
  }
}

export class LoopService extends Disposable implements ILoopService {
  private readonly openSteps = new Map<string, OpenStep>();
  private ownSpliceDepth = 0;
  private protocolTurnId: number | undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @IEventBus private readonly events: IEventBus,
    @IToolRegistry private readonly toolRegistry: IToolRegistry,
    @IToolExecutor private readonly toolExecutor: IToolExecutor,
    @IUsageService private readonly usage: IUsageService,
    @IProfileService private readonly profile: IProfileService,
    @IWireRecord private readonly wireRecord: IWireRecord,
  ) {
    super();
    this.context.hooks.onSpliced.register('loop-service-reconcile', async (_event, next) => {
      if (this.ownSpliceDepth === 0) {
        this.resetLiveStateFromHistory();
      }
      await next();
    });
    this.wireRecord.hooks.onResumeEnded.register(
      'loop-service-finish-resume',
      async (_event, next) => {
        this.finishResume();
        await next();
      },
    );
  }

  async runTurn(turn: Turn, hooks: LoopRunHooks | undefined): Promise<TurnResult> {
    let usageModel = this.profile.data().modelAlias ?? 'unknown';
    this.protocolTurnId = turn.id;
    const result = await runLoopTurn({
      turnId: String(turn.id),
      signal: turn.abortController.signal,
      llm: this.createLLM((model) => {
        usageModel = model ?? this.profile.data().modelAlias ?? 'unknown';
      }),
      buildMessages: () => [...this.projector.project(this.context.getHistory())],
      dispatchEvent: this.dispatchEvent,
      tools: this.executableTools(),
      hooks: this.loopHooks(turn, hooks),
      recordStepUsage: (usage) => {
        this.usage.record(usageModel, usage, 'turn');
      },
    }).finally(() => {
      if (this.protocolTurnId === turn.id) {
        this.protocolTurnId = undefined;
      }
    });
    if (result.stopReason === 'aborted') {
      return { reason: 'cancelled', error: turn.abortController.signal.reason };
    }
    return { reason: 'completed' };
  }

  private handleEvent(event: LoopRecordedEvent): void {
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.openSteps.set(event.uuid, { message, inserted: false });
        return;
      }
      case 'step.end':
        this.openSteps.delete(event.uuid);
        return;
      case 'content.part':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          content: [...message.content, cloneContentPart(event.part)],
        }));
        return;
      case 'tool.call':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          toolCalls: [
            ...message.toolCalls,
            {
              type: 'function',
              id: event.toolCallId,
              name: event.name,
              arguments: stringifyToolArguments(event.args),
            },
          ],
        }));
        return;
      case 'tool.result':
        this.appendToolResult(event.toolCallId, event.result);
        return;
    }
  }

  private readonly dispatchEvent = ((event: LoopEvent) => {
    if (isRecordedLoopEvent(event)) {
      this.handleEvent(event);
      this.emitProtocolEvent(event);
      return Promise.resolve();
    }
    this.emitProtocolEvent(event);
    return undefined;
  }) as LoopEventDispatcher;

  private emitProtocolEvent(event: LoopEvent): void {
    switch (event.type) {
      case 'step.begin':
        this.events.emit({
          type: 'turn.step.started',
          turnId: Number(event.turnId),
          step: event.step,
          stepId: event.uuid,
        });
        return;
      case 'step.end':
        this.events.emit({
          type: 'turn.step.completed',
          turnId: Number(event.turnId),
          step: event.step,
          stepId: event.uuid,
          usage: event.usage,
          finishReason: event.finishReason,
          llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
          llmStreamDurationMs: event.llmStreamDurationMs,
          providerFinishReason: event.providerFinishReason,
          rawFinishReason: event.rawFinishReason,
        });
        return;
      case 'text.delta':
        if (this.protocolTurnId === undefined) return;
        this.events.emit({
          type: 'assistant.delta',
          turnId: this.protocolTurnId,
          delta: event.delta,
        });
        return;
      case 'thinking.delta':
        if (this.protocolTurnId === undefined) return;
        this.events.emit({
          type: 'thinking.delta',
          turnId: this.protocolTurnId,
          delta: event.delta,
        });
        return;
      case 'tool.call.delta':
        if (this.protocolTurnId === undefined) return;
        this.events.emit({
          type: 'tool.call.delta',
          turnId: this.protocolTurnId,
          toolCallId: event.toolCallId,
          name: event.name,
          argumentsPart: event.argumentsPart,
        });
        return;
      default:
        return;
    }
  }

  private createLLM(onUsageModel: (model: string | undefined) => void): LLM {
    return {
      systemPrompt: this.profile.getSystemPrompt(),
      modelName: this.profile.data().modelAlias ?? 'unknown',
      chat: async (params) => this.chat(params, onUsageModel),
    };
  }

  private async chat(
    params: LLMChatParams,
    onUsageModel: (model: string | undefined) => void,
  ): Promise<LLMChatResponse> {
    const collector = new LLMEventCollector();
    const toolCallDeltas = new ToolCallDeltaEmitter(params);
    let usage = emptyUsage();
    let providerFinishReason: LLMChatResponse['providerFinishReason'];
    let rawFinishReason: string | undefined;
    let streamTiming: LLMChatResponse['streamTiming'];
    const stream = this.llmRequester.request(
      {
        messages: params.messages,
        tools: params.tools,
        systemPrompt: this.profile.getSystemPrompt(),
        requestLogFields: params.requestLogFields,
      },
      params.signal,
    );

    for await (const event of stream) {
      params.signal.throwIfAborted();
      switch (event.type) {
        case 'part':
          emitStreamDelta(params, event.part);
          toolCallDeltas.accept(event.part);
          collector.accept(event.part);
          continue;
        case 'usage':
          usage = event.usage;
          onUsageModel(event.model);
          continue;
        case 'finish':
          providerFinishReason = event.providerFinishReason;
          rawFinishReason = event.rawFinishReason;
          continue;
        case 'timing':
          streamTiming = {
            firstTokenLatencyMs: event.firstTokenLatencyMs,
            streamDurationMs: event.streamDurationMs,
          };
          continue;
      }
    }

    const assistant = collector.toAssistantMessage();
    for (const part of assistant.content) {
      await emitCompletedContentPart(params, part);
    }
    return {
      toolCalls: assistant.toolCalls,
      usage,
      providerFinishReason,
      rawFinishReason,
      streamTiming,
    };
  }

  private executableTools(): readonly ExecutableTool[] {
    return this.toolRegistry.list().map((tool) => this.executableTool(tool));
  }

  private executableTool(tool: ToolDefinition): ExecutableTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      resolveExecution: (args) => ({
        approvalRule: tool.name,
        execute: async (context) =>
          toExecutableToolResult(
            await this.toolExecutor.execute(
              {
                id: context.toolCallId,
                name: tool.name,
                arguments: args,
              },
              {
                signal: context.signal,
                turnId: context.turnId,
                metadata: context.metadata,
                onUpdate: context.onUpdate,
              },
            ),
          ),
      }),
    };
  }

  private loopHooks(turn: Turn, hooks: LoopRunHooks | undefined): LoopHooks | undefined {
    if (hooks === undefined) return undefined;
    let continueAfterStop = false;
    return {
      beforeStep: async () => {
        await hooks.beforeStep.run({ turn, continueTurn: false });
        return undefined;
      },
      afterStep: async (context) => {
        const turnContext = { turn, continueTurn: false };
        await hooks.afterStep.run(turnContext);
        if (context.stopReason !== 'tool_use' && turnContext.continueTurn) {
          continueAfterStop = true;
        }
        return undefined;
      },
      shouldContinueAfterStop: async () => {
        const shouldContinue = continueAfterStop;
        continueAfterStop = false;
        return { continue: shouldContinue };
      },
    };
  }

  private finishResume(): void {
    const interruptedToolCallIds = unresolvedToolCallIdsFromHistory(this.context.getHistory());
    this.openSteps.clear();
    for (const toolCallId of interruptedToolCallIds) {
      this.handleEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output: TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
          isError: true,
        },
      });
    }
  }

  private replaceOpenStep(
    stepUuid: string,
    update: (message: ContextMessage) => ContextMessage,
  ): void {
    const message = this.openSteps.get(stepUuid);
    if (message === undefined) {
      throw new Error(
        `Received loop event for unknown step_uuid '${stepUuid}' (no open step_begin)`,
      );
    }

    const next = update(message.message);
    if (!message.inserted) {
      this.appendImmediately(next);
      this.openSteps.set(stepUuid, { message: next, inserted: true });
      return;
    }

    const history = this.context.getHistory();
    const index = history.indexOf(message.message);
    if (index < 0) {
      throw new Error(`Open loop step '${stepUuid}' is no longer present in context history`);
    }
    this.spliceHistory(index, 1, next);
    this.openSteps.set(stepUuid, { message: next, inserted: true });
  }

  private appendToolResult(toolCallId: string, result: ExecutableToolResult): void {
    const message = createToolMessage(toolCallId, toolResultOutputForModel(result));
    this.appendImmediately({
      ...message,
      role: 'tool',
      isError: result.isError,
    });
  }

  private appendImmediately(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.spliceHistory(this.context.getHistory().length, 0, ...messages);
  }

  private spliceHistory(
    start: number,
    deleteCount: number,
    ...messages: ContextMessage[]
  ): void {
    this.ownSpliceDepth++;
    try {
      this.context.spliceHistory(start, deleteCount, ...messages);
    } finally {
      this.ownSpliceDepth--;
    }
  }

  private resetLiveStateFromHistory(): void {
    this.openSteps.clear();
  }
}

interface OpenStep {
  readonly message: ContextMessage;
  readonly inserted: boolean;
}

function unresolvedToolCallIdsFromHistory(history: readonly ContextMessage[]): string[] {
  const answered = new Set<string>();
  for (const message of history) {
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      answered.add(message.toolCallId);
    }
  }

  const unresolved: string[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      if (!answered.has(toolCall.id)) {
        unresolved.push(toolCall.id);
      }
    }
  }
  return unresolved;
}

function stringifyToolArguments(args: unknown): string | null {
  if (args === undefined) return null;
  return JSON.stringify(args) ?? null;
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output.map(cloneContentPart)];
  }
  return output.map(cloneContentPart);
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function cloneContentPart<T extends ContentPart>(part: T): T {
  return { ...part };
}

function isRecordedLoopEvent(event: LoopEvent): event is LoopRecordedEvent {
  return (
    event.type === 'step.begin' ||
    event.type === 'step.end' ||
    event.type === 'content.part' ||
    event.type === 'tool.call' ||
    event.type === 'tool.result'
  );
}

function emitStreamDelta(params: LLMChatParams, part: StreamedMessagePart): void {
  if (part.type === 'text') {
    params.onTextDelta?.(part.text);
    return;
  }
  if (part.type === 'think') {
    params.onThinkDelta?.(part.think);
  }
}

async function emitCompletedContentPart(
  params: LLMChatParams,
  part: ContentPart,
): Promise<void> {
  if (part.type === 'text') {
    await params.onTextPart?.(part);
    return;
  }
  if (part.type === 'think') {
    await params.onThinkPart?.(part);
  }
}

function toExecutableToolResult(result: ToolResult): ExecutableToolResult {
  if (result.isError === true) {
    return { output: result.output, isError: true };
  }
  return { output: result.output };
}

class LLMEventCollector {
  private readonly parts: StreamedMessagePart[] = [];
  private readonly indexedToolCalls = new Map<number | string, KosongToolCall>();
  private readonly pendingIndexedToolCallDeltas = new Map<
    number | string,
    StreamedMessagePart[]
  >();
  private lastToolCall: KosongToolCall | undefined;

  accept(part: StreamedMessagePart): void {
    if (isToolCallPart(part)) {
      if (part.index !== undefined) {
        const toolCall = this.indexedToolCalls.get(part.index);
        if (toolCall !== undefined) {
          mergeInPlace(toolCall, part);
          return;
        }
        const pending = this.pendingIndexedToolCallDeltas.get(part.index) ?? [];
        pending.push(cloneStreamedPart(part));
        this.pendingIndexedToolCallDeltas.set(part.index, pending);
        return;
      }
      if (this.lastToolCall !== undefined) {
        mergeInPlace(this.lastToolCall, part);
      }
      return;
    }

    const previous = this.parts.at(-1);
    if (previous !== undefined && mergeInPlace(previous, part)) {
      return;
    }

    if (isToolCall(part)) {
      const cloned = cloneStreamedPart(part) as KosongToolCall;
      this.parts.push(cloned);
      this.lastToolCall = cloned;
      if (part._streamIndex !== undefined) {
        this.indexedToolCalls.set(part._streamIndex, cloned);
        const pending = this.pendingIndexedToolCallDeltas.get(part._streamIndex);
        if (pending !== undefined) {
          this.pendingIndexedToolCallDeltas.delete(part._streamIndex);
          for (const delta of pending) {
            mergeInPlace(cloned, delta);
          }
        }
      }
      return;
    }

    this.parts.push(cloneStreamedPart(part));
  }

  toAssistantMessage(): Pick<ContextMessage, 'content' | 'toolCalls'> {
    const content: ContentPart[] = [];
    const toolCalls: KosongToolCall[] = [];
    for (const part of this.parts) {
      if (isContentPart(part)) {
        content.push(part);
      } else if (isToolCall(part)) {
        toolCalls.push(stripStreamIndex(part));
      }
    }

    return { content, toolCalls };
  }
}

function cloneStreamedPart(part: StreamedMessagePart): StreamedMessagePart {
  return { ...part } as StreamedMessagePart;
}

function stripStreamIndex(toolCall: KosongToolCall): KosongToolCall {
  const { _streamIndex, ...rest } = toolCall;
  void _streamIndex;
  return rest;
}

class ToolCallDeltaEmitter {
  private readonly toolCallIdentities = new Map<number | string, ToolCallIdentity>();
  private readonly pendingIndexedDeltas = new Map<number | string, ToolCallDelta[]>();
  private lastToolCallIdentity: ToolCallIdentity | undefined;

  constructor(private readonly params: LLMChatParams) {}

  accept(part: StreamedMessagePart): void {
    if (isToolCall(part)) {
      const identity = { toolCallId: part.id, name: part.name };
      this.lastToolCallIdentity = identity;
      if (part._streamIndex !== undefined) {
        this.toolCallIdentities.set(part._streamIndex, identity);
      }
      this.emit(identity, part.arguments === null ? {} : { argumentsPart: part.arguments });
      if (part._streamIndex !== undefined) {
        const pending = this.pendingIndexedDeltas.get(part._streamIndex);
        if (pending !== undefined) {
          this.pendingIndexedDeltas.delete(part._streamIndex);
          for (const delta of pending) {
            this.emit(identity, delta);
          }
        }
      }
      return;
    }

    if (!isToolCallPart(part)) return;

    const delta = part.argumentsPart === null ? {} : { argumentsPart: part.argumentsPart };
    if (part.index !== undefined) {
      const identity = this.toolCallIdentities.get(part.index);
      if (identity !== undefined) {
        this.emit(identity, delta);
        return;
      }
      const pending = this.pendingIndexedDeltas.get(part.index) ?? [];
      pending.push(delta);
      this.pendingIndexedDeltas.set(part.index, pending);
      return;
    }

    if (this.lastToolCallIdentity !== undefined) {
      this.emit(this.lastToolCallIdentity, delta);
    }
  }

  private emit(identity: ToolCallIdentity, delta: ToolCallDelta): void {
    this.params.onToolCallDelta?.({
      toolCallId: identity.toolCallId,
      name: identity.name,
      ...delta,
    });
  }
}

interface ToolCallIdentity {
  readonly toolCallId: string;
  readonly name: string;
}

interface ToolCallDelta {
  readonly argumentsPart?: string;
}

registerSingleton(ILoopService, new SyncDescriptor(LoopService, [], true));
