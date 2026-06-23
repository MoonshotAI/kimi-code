import { randomUUID } from 'node:crypto';

import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type ContentPart,
  type StreamedMessagePart,
  type TextPart,
  type ThinkPart,
  type ToolCall as KosongToolCall,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from '../../../di';
import type { ExecutableToolResult } from '../../../loop';
import { IProfileService } from '../profile/profile';
import { IUsageService } from '../usage/usage';
import { OrderedHookSlot } from '../hooks';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { ILoopService } from '../loop/loop';
import { IToolExecutor } from '../toolExecutor/toolExecutor';
import type {
  ContextMessage,
  LLMEvent,
  ToolCall,
  ToolResult,
  Turn,
  TurnResult,
  TurnStepContext,
} from '../types';
import { ITurnRunner } from './turnRunner';

export class TurnRunnerService implements ITurnRunner {
  private activeTurn: Turn | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    beforeStep: new OrderedHookSlot<TurnStepContext>(),
    afterStep: new OrderedHookSlot<TurnStepContext>(),
  };

  constructor(
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @ILoopService private readonly loop: ILoopService,
    @IToolExecutor private readonly toolExecutor: IToolExecutor,
    @IUsageService private readonly usage: IUsageService,
    @IProfileService private readonly profile: IProfileService,
  ) {}

  launch(): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: randomUUID(),
      abortController,
      ready: ready.promise,
      result: Promise.resolve({ reason: 'failed' }),
    };
    turn.result = this.runTurn(turn, ready).finally(() => {
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
    });
    this.activeTurn = turn;
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  private async runTurn(
    turn: Turn,
    ready: ControlledPromise<void>,
  ): Promise<TurnResult> {
    let readySettled = false;
    try {
      this.usage.beginTurn();
      let step = 0;
      while (true) {
        step += 1;
        const stepUuid = randomUUID();
        const stepContext: TurnStepContext = { turn, continueTurn: false };
        await this.hooks.beforeStep.run(stepContext);
        this.loop.handleEvent({
          type: 'step.begin',
          uuid: stepUuid,
          turnId: turn.id,
          step,
        });
        const collector = new LLMEventCollector();
        const stream = this.llmRequester.request(undefined, turn.abortController.signal);
        let stepUsage: TokenUsage | undefined;
        let providerFinishReason: Extract<LLMEvent, { type: 'finish' }>['providerFinishReason'];
        let rawFinishReason: string | undefined;
        let firstTokenLatencyMs: number | undefined;
        let streamDurationMs: number | undefined;
        if (!readySettled) {
          ready.resolve();
          readySettled = true;
        }

        for await (const event of stream) {
          turn.abortController.signal.throwIfAborted();
          if (event.type === 'usage') {
            stepUsage = event.usage;
            this.usage.record(
              event.model ?? this.profile.data().modelAlias ?? 'unknown',
              event.usage,
              'turn',
            );
          } else if (event.type === 'finish') {
            providerFinishReason = event.providerFinishReason;
            rawFinishReason = event.rawFinishReason;
          } else if (event.type === 'timing') {
            firstTokenLatencyMs = event.firstTokenLatencyMs;
            streamDurationMs = event.streamDurationMs;
          }
          collector.accept(event);
        }

        const assistant = collector.toAssistantMessage();
        for (const part of assistant.content) {
          if (!isRecordedContentPart(part)) continue;
          this.loop.handleEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turn.id,
            step,
            stepUuid,
            part,
          });
        }
        for (const toolCall of assistant.toolCalls) {
          this.loop.handleEvent({
            type: 'tool.call',
            uuid: randomUUID(),
            turnId: turn.id,
            step,
            stepUuid,
            toolCallId: toolCall.id,
            name: toolCall.name,
            args: parseToolArguments(toolCall.arguments),
          });
        }
        for (const toolCall of assistant.toolCalls) {
          const result = await this.toolExecutor.execute(toToolCall(toolCall));
          this.loop.handleEvent({
            type: 'tool.result',
            parentUuid: toolCall.id,
            toolCallId: toolCall.id,
            result: toExecutableToolResult(result),
          });
        }

        this.loop.handleEvent({
          type: 'step.end',
          uuid: stepUuid,
          turnId: turn.id,
          step,
          usage: stepUsage,
          finishReason: assistant.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          llmFirstTokenLatencyMs: firstTokenLatencyMs,
          llmStreamDurationMs: streamDurationMs,
          providerFinishReason,
          rawFinishReason,
        });
        stepContext.continueTurn = assistant.toolCalls.length > 0;
        await this.hooks.afterStep.run(stepContext);
        if (!stepContext.continueTurn) break;
      }
      return { reason: 'completed' };
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        if (!readySettled) {
          ready.resolve();
        }
        return { reason: 'cancelled', error: turn.abortController.signal.reason };
      }
      if (!readySettled) {
        ready.reject(error);
      }
      return { reason: 'failed', error };
    } finally {
      this.usage.endTurn();
    }
  }
}

interface ControlledPromise<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class LLMEventCollector {
  private readonly parts: StreamedMessagePart[] = [];

  accept(event: LLMEvent): void {
    if (event.type !== 'part') return;
    this.acceptPart(event.part);
  }

  toAssistantMessage(): ContextMessage {
    const content: ContentPart[] = [];
    const toolCalls: KosongToolCall[] = [];
    for (const part of this.parts) {
      if (isContentPart(part)) {
        content.push(part);
      } else if (isToolCall(part)) {
        toolCalls.push(stripStreamIndex(part));
      }
    }

    return {
      role: 'assistant',
      content,
      toolCalls,
    };
  }

  private acceptPart(part: StreamedMessagePart): void {
    const previous = this.parts.at(-1);
    if (previous !== undefined && mergeInPlace(previous, part)) {
      return;
    }
    if (isToolCallPart(part)) {
      return;
    }
    this.parts.push(clonePart(part));
  }
}

function clonePart(part: StreamedMessagePart): StreamedMessagePart {
  return { ...part } as StreamedMessagePart;
}

function stripStreamIndex(toolCall: KosongToolCall): KosongToolCall {
  const { _streamIndex, ...rest } = toolCall;
  void _streamIndex;
  return rest;
}

function toToolCall(toolCall: KosongToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: parseToolArguments(toolCall.arguments),
    raw: toolCall,
  };
}

function parseToolArguments(args: string | null): unknown {
  if (args === null || args.length === 0) return undefined;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function isRecordedContentPart(part: ContentPart): part is TextPart | ThinkPart {
  return part.type === 'text' || part.type === 'think';
}

function toExecutableToolResult(result: ToolResult): ExecutableToolResult {
  if (result.isError === true) {
    return { output: result.output, isError: true };
  }
  return { output: result.output };
}

registerSingleton(ITurnRunner, new SyncDescriptor(TurnRunnerService, [], true));
