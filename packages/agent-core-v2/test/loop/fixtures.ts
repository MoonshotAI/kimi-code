import { emptyUsage, type Message, type ModelCapability, type TextPart, type ThinkPart, type TokenUsage, type ToolCall } from '@moonshot-ai/kosong';

import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type ToolDidExecuteContext,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
  type ToolWillExecuteContext,
} from '#/tool';
import { OrderedHookSlot } from '#/hooks';
import type { ILogger as Logger } from '#/log';
import { createLoopEventDispatcher, runTurn as runTurnImpl, type LLM, type LLMChatParams, type LLMChatResponse, type LoopEvent, type LoopHooks, type LoopLiveEventEmitter, type LoopMessageBuilder, type LoopRecordedEvent, type LoopStepStopReason, type RunTurnInput, type TurnResult } from '#/loop';
import type { IToolExecutor } from '#/toolExecutor';

export type FakeOutputPart = TextPart | ThinkPart;

export interface FakeLLMResponse extends LLMChatResponse {
  readonly contentParts?: readonly FakeOutputPart[] | undefined;
  readonly textDeltas?: readonly string[] | undefined;
  readonly thinkDeltas?: readonly string[] | undefined;
  readonly toolCallDeltas?:
  | ReadonlyArray<{ readonly toolCallId: string; readonly name?: string; readonly argumentsPart?: string }>
  | undefined;
}

export interface FakeLLMOptions {
  readonly responses: readonly FakeLLMResponse[];
  readonly throwOnIndex?: { readonly index: number; readonly error: unknown } | undefined;
  readonly abortOnIndex?:
  | { readonly index: number; readonly controller: AbortController }
  | undefined;
  readonly delayMs?: number | undefined;
  readonly modelName?: string | undefined;
  readonly capability?: ModelCapability | undefined;
  readonly systemPrompt?: string | undefined;
  readonly isRetryableError?: ((error: unknown) => boolean) | undefined;
}

export class FakeLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  readonly isRetryableError?: ((error: unknown) => boolean) | undefined;
  readonly calls: LLMChatParams[] = [];

  private index = 0;
  private readonly responses: readonly FakeLLMResponse[];
  private readonly throwOnIndex: FakeLLMOptions['throwOnIndex'];
  private readonly abortOnIndex: FakeLLMOptions['abortOnIndex'];
  private readonly delayMs: number;

  constructor(opts: FakeLLMOptions) {
    this.systemPrompt = opts.systemPrompt ?? 'fake system prompt';
    this.modelName = opts.modelName ?? 'fake-model';
    this.capability = opts.capability;
    this.responses = opts.responses;
    this.throwOnIndex = opts.throwOnIndex;
    this.abortOnIndex = opts.abortOnIndex;
    this.delayMs = opts.delayMs ?? 0;
    this.isRetryableError = opts.isRetryableError;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    this.calls.push(params);
    const current = this.index;
    this.index += 1;

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.abortOnIndex !== undefined && this.abortOnIndex.index === current) {
      this.abortOnIndex.controller.abort();
    }

    if (params.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (this.throwOnIndex !== undefined && this.throwOnIndex.index === current) {
      throw this.throwOnIndex.error;
    }

    const response = this.responses[current];
    if (response === undefined) {
      throw new Error(`FakeLLM ran out of responses at call ${String(current + 1)}`);
    }

    for (const delta of response.textDeltas ?? []) {
      params.onTextDelta?.(delta);
    }
    for (const delta of response.thinkDeltas ?? []) {
      params.onThinkDelta?.(delta);
    }
    for (const delta of response.toolCallDeltas ?? []) {
      params.onToolCallDelta?.(delta);
    }
    for (const part of response.contentParts ?? []) {
      if (part.type === 'text') {
        await params.onTextPart?.(part);
      } else {
        await params.onThinkPart?.(part);
      }
    }

    return response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}

export type AppendCall =
  | { kind: 'appendStepBegin'; input: Extract<LoopRecordedEvent, { type: 'step.begin' }> }
  | { kind: 'appendStepEnd'; input: Extract<LoopRecordedEvent, { type: 'step.end' }> }
  | { kind: 'appendContentPart'; input: Extract<LoopRecordedEvent, { type: 'content.part' }> }
  | { kind: 'appendToolCall'; input: Extract<LoopRecordedEvent, { type: 'tool.call' }> }
  | { kind: 'appendToolResult'; input: Extract<LoopRecordedEvent, { type: 'tool.result' }> };

export class RecordingContext {
  readonly calls: AppendCall[] = [];
  readonly buildMessagesCalls: number[] = [];

  private messages: Message[];

  constructor(messages: Message[] = []) {
    this.messages = messages;
  }

  readonly buildMessages: LoopMessageBuilder = () => {
    this.buildMessagesCalls.push(this.calls.length);
    return this.messages;
  };

  readonly appendTranscriptRecord = async (record: LoopRecordedEvent): Promise<void> => {
    switch (record.type) {
      case 'step.begin':
        this.calls.push({ kind: 'appendStepBegin', input: record });
        return;
      case 'step.end':
        this.calls.push({ kind: 'appendStepEnd', input: record });
        return;
      case 'content.part':
        this.calls.push({ kind: 'appendContentPart', input: record });
        return;
      case 'tool.call':
        this.calls.push({ kind: 'appendToolCall', input: record });
        return;
      case 'tool.result':
        this.calls.push({ kind: 'appendToolResult', input: record });
    }
  };

  kinds(): AppendCall['kind'][] {
    return this.calls.map((call) => call.kind);
  }

  ofKind<K extends AppendCall['kind']>(kind: K): Extract<AppendCall, { kind: K }>[] {
    return this.calls.filter((call): call is Extract<AppendCall, { kind: K }> => call.kind === kind);
  }

  stepBegins(): Array<Extract<LoopRecordedEvent, { type: 'step.begin' }>> {
    return this.ofKind('appendStepBegin').map((call) => call.input);
  }

  stepEnds(): Array<Extract<LoopRecordedEvent, { type: 'step.end' }>> {
    return this.ofKind('appendStepEnd').map((call) => call.input);
  }

  contentParts(): Array<Extract<LoopRecordedEvent, { type: 'content.part' }>> {
    return this.ofKind('appendContentPart').map((call) => call.input);
  }

  toolCalls(): Array<Extract<LoopRecordedEvent, { type: 'tool.call' }>> {
    return this.ofKind('appendToolCall').map((call) => call.input);
  }

  toolResults(): Array<Extract<LoopRecordedEvent, { type: 'tool.result' }>> {
    return this.ofKind('appendToolResult').map((call) => call.input);
  }
}

export type SinkErrorMode =
  | { kind: 'none' }
  | { kind: 'sync-throw'; onlyAt?: number }
  | { kind: 'async-reject'; onlyAt?: number }
  | { kind: 'every-call-throws' };

export class CollectingSink {
  readonly events: LoopEvent[] = [];
  private callCount = 0;

  constructor(private mode: SinkErrorMode = { kind: 'none' }) { }

  readonly emit: LoopLiveEventEmitter = (event) => {
    const callIndex = this.callCount;
    this.callCount += 1;

    if (this.mode.kind === 'every-call-throws') {
      this.events.push(event);
      throw new Error('sink fails on every emit');
    }

    if (
      this.mode.kind === 'sync-throw' &&
      (this.mode.onlyAt === undefined || this.mode.onlyAt === callIndex)
    ) {
      throw new Error(`sink sync throw at call ${String(callIndex)}`);
    }

    if (
      this.mode.kind === 'async-reject' &&
      (this.mode.onlyAt === undefined || this.mode.onlyAt === callIndex)
    ) {
      const rejected = Promise.reject(new Error(`sink async reject at call ${String(callIndex)}`));
      this.events.push(event);
      return rejected as unknown as void;
    }

    this.events.push(event);
  };

  typesIn(): LoopEvent['type'][] {
    return this.events.map((event) => event.type);
  }

  count(type: LoopEvent['type']): number {
    return this.events.filter((event) => event.type === type).length;
  }

  byType<T extends LoopEvent['type']>(type: T): Array<Extract<LoopEvent, { type: T }>> {
    return this.events.filter((event): event is Extract<LoopEvent, { type: T }> => event.type === type);
  }
}

export interface RunTurnOptions {
  readonly responses: readonly FakeLLMResponse[];
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly maxSteps?: number | undefined;
  readonly turnId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly emitLiveEvent?: LoopLiveEventEmitter | undefined;
  readonly llmThrowOnIndex?: { index: number; error: unknown } | undefined;
  readonly llmAbortOnIndex?: { index: number; controller: AbortController } | undefined;
  readonly llmDelayMs?: number | undefined;
  readonly systemPrompt?: string | undefined;
  readonly sinkErrorMode?: SinkErrorMode | undefined;
  readonly recordStepUsage?: RunTurnInput['recordStepUsage'] | undefined;
  readonly toolExecutor?: IToolExecutor | undefined;
}

export interface RunTurnResult {
  readonly result: TurnResult;
  readonly llm: FakeLLM;
  readonly context: RecordingContext;
  readonly sink: CollectingSink;
  readonly toolExecutor: IToolExecutor;
}

export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const llm = new FakeLLM({
    responses: opts.responses,
    throwOnIndex: opts.llmThrowOnIndex,
    abortOnIndex: opts.llmAbortOnIndex,
    delayMs: opts.llmDelayMs,
    systemPrompt: opts.systemPrompt,
  });
  const context = new RecordingContext();
  const fallback = new CollectingSink(opts.sinkErrorMode);
  const toolExecutor = opts.toolExecutor ?? new InlineToolExecutor(opts.tools ?? []);
  const input: RunTurnInput = {
    turnId: opts.turnId ?? 'turn-1',
    signal: opts.signal ?? new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: opts.emitLiveEvent ?? fallback.emit,
    }),
    tools: opts.tools,
    hooks: opts.hooks,
    log: opts.log,
    maxSteps: opts.maxSteps,
    recordStepUsage: opts.recordStepUsage,
    toolExecutor,
  };
  const result = await runTurnImpl(input);
  return { result, llm, context, sink: fallback, toolExecutor };
}

export async function runTurnExpectingThrow(opts: RunTurnOptions): Promise<{
  readonly error: unknown;
  readonly llm: FakeLLM;
  readonly context: RecordingContext;
  readonly sink: CollectingSink;
}> {
  const llm = new FakeLLM({
    responses: opts.responses,
    throwOnIndex: opts.llmThrowOnIndex,
    abortOnIndex: opts.llmAbortOnIndex,
    delayMs: opts.llmDelayMs,
    systemPrompt: opts.systemPrompt,
  });
  const context = new RecordingContext();
  const fallback = new CollectingSink(opts.sinkErrorMode);
  const toolExecutor = opts.toolExecutor ?? new InlineToolExecutor(opts.tools ?? []);
  const input: RunTurnInput = {
    turnId: opts.turnId ?? 'turn-1',
    signal: opts.signal ?? new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: opts.emitLiveEvent ?? fallback.emit,
    }),
    tools: opts.tools,
    hooks: opts.hooks,
    log: opts.log,
    maxSteps: opts.maxSteps,
    recordStepUsage: opts.recordStepUsage,
    toolExecutor,
  };
  try {
    await runTurnImpl(input);
  } catch (error) {
    return {
      error,
      llm,
      context,
      sink: fallback,
    };
  }
  throw new Error('runTurnExpectingThrow: expected throw, got resolution');
}

export function makeTextParts(text: string): FakeOutputPart[] {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

export function makeThinkingParts(thinking: string, text = '', signature?: string): FakeOutputPart[] {
  const parts: FakeOutputPart[] =
    signature !== undefined
      ? [{ type: 'think', think: thinking, encrypted: signature }]
      : [{ type: 'think', think: thinking }];
  if (text.length > 0) parts.push({ type: 'text', text });
  return parts;
}

export function makeEndTurnResponse(text: string, usage: Partial<TokenUsage> = {}): FakeLLMResponse {
  return {
    toolCalls: [],
    providerFinishReason: 'completed',
    usage: zeroUsage(usage),
    contentParts: makeTextParts(text),
  };
}

export function makeMaxTokensResponse(text: string, usage: Partial<TokenUsage> = {}): FakeLLMResponse {
  return {
    toolCalls: [],
    providerFinishReason: 'truncated',
    usage: zeroUsage(usage),
    contentParts: makeTextParts(text),
  };
}

export function makeToolUseResponse(toolCalls: ToolCall[], usage: Partial<TokenUsage> = {}): FakeLLMResponse {
  return {
    toolCalls,
    providerFinishReason: 'tool_calls',
    usage: zeroUsage(usage),
  };
}

export function makeResponse(
  contentParts: readonly FakeOutputPart[],
  toolCalls: ToolCall[],
  stopReason: LoopStepStopReason,
  usage: Partial<TokenUsage> = {},
): FakeLLMResponse {
  return {
    contentParts,
    toolCalls,
    providerFinishReason: providerFinishReasonForStopReason(stopReason),
    usage: zeroUsage(usage),
  };
}

export function zeroUsage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

export function makeToolCall(name: string, args: unknown, id = `call_${name}`): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

export class EchoTool implements ExecutableTool<{ text: string }> {
  readonly name: string;
  readonly description = 'Return the input text unchanged.';
  readonly parameters = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };
  readonly calls: Array<{ readonly id: string; readonly args: { text: string }; readonly turnId: string }> = [];

  constructor(name = 'echo') {
    this.name = name;
  }

  resolveExecution(args: { text: string }): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({ id: ctx.toolCallId, args, turnId: ctx.turnId });
        return { output: args.text };
      },
    };
  }
}

export class ControlledTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Controlled test tool.';
  readonly parameters = { type: 'object', additionalProperties: true };
  readonly calls: Array<{ readonly id: string; readonly args: Record<string, unknown>; readonly signal: AbortSignal }> = [];
  readonly started: Promise<void>;
  private resolveStarted: () => void = () => { };
  private resolveResult: (value: ExecutableToolResult) => void = () => { };
  private rejectResult: (error: unknown) => void = () => { };
  private readonly result: Promise<ExecutableToolResult>;

  constructor(
    readonly name: string,
    private readonly accesses: ToolAccesses = ToolAccesses.all(),
  ) {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: this.accesses,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({ id: ctx.toolCallId, args, signal: ctx.signal });
        this.resolveStarted();
        if (ctx.signal.aborted) {
          const error = new Error('aborted before start');
          error.name = 'AbortError';
          throw error;
        }
        const onAbort = (): void => {
          const error = new Error('tool aborted');
          error.name = 'AbortError';
          this.rejectResult(error);
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await this.result;
        } finally {
          ctx.signal.removeEventListener('abort', onAbort);
        }
      },
    };
  }

  resolve(output = `${this.name} result`): void {
    this.resolveResult({ output });
  }

  reject(error: unknown): void {
    this.rejectResult(error);
  }
}

class InlineToolExecutor implements IToolExecutor {
  declare readonly _serviceBrand: undefined;
  readonly hooks = {
    onWillExecuteTool: new OrderedHookSlot<ToolWillExecuteContext>(),
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };

  private readonly tools: Map<string, ExecutableTool>;

  constructor(tools: readonly ExecutableTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async execute(calls: ToolCall[], options: Parameters<IToolExecutor['execute']>[1] = {}): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      const parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) as unknown : call.arguments;
      const tool = this.tools.get(call.name);
      await options.dispatchEvent?.({
        type: 'tool.call',
        uuid: call.id,
        turnId: options.turnId ?? '',
        step: options.stepNumber ?? 0,
        stepUuid: options.stepUuid ?? '',
        toolCallId: call.id,
        name: call.name,
        args: parsedArgs,
      });
      if (tool === undefined) {
        const result = { output: `Tool "${call.name}" not found`, isError: true };
        await options.dispatchEvent?.({
          type: 'tool.result',
          parentUuid: call.id,
          toolCallId: call.id,
          result,
        });
        results.push(result);
        continue;
      }
      const execution = await tool.resolveExecution(parsedArgs);
      const rawResult =
        execution.isError === true
          ? execution
          : await execution.execute({
            turnId: options.turnId ?? '',
            toolCallId: call.id,
            signal: options.signal ?? new AbortController().signal,
            onUpdate: (update: ToolUpdate) => options.onProgress?.(call.id, update),
          });
      const result: ToolResult = {
        output: rawResult.output,
        isError: rawResult.isError,
        stopTurn: rawResult.stopTurn,
      };
      await options.dispatchEvent?.({
        type: 'tool.result',
        parentUuid: call.id,
        toolCallId: call.id,
        result,
      });
      results.push(result);
    }
    return results;
  }
}

function providerFinishReasonForStopReason(reason: LoopStepStopReason): FakeLLMResponse['providerFinishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'completed';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'truncated';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'unknown':
      return 'other';
  }
}
