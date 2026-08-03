import {
  emptyUsage,
  type FinishReason,
  type ModelCapability,
  type TextPart,
  type ThinkPart,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LoopStepStopReason,
  ToolCall,
} from '../../../src/loop/index';

export type FakeOutputPart = TextPart | ThinkPart;

export interface FakeLLMResponse extends LLMChatResponse {
  readonly contentParts?: readonly FakeOutputPart[] | undefined;
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
}

export class FakeLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;

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

    if (current >= this.responses.length) {
      throw new Error(`FakeLLM ran out of responses at call ${String(current + 1)}`);
    }

    const response = this.responses[current];
    if (response === undefined) {
      throw new Error(`FakeLLM: missing response at index ${String(current)}`);
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

export function makeTextParts(text: string): FakeOutputPart[] {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

export function makeThinkingParts(
  thinking: string,
  text = '',
  signature?: string,
): FakeOutputPart[] {
  const parts: FakeOutputPart[] =
    signature !== undefined
      ? [{ type: 'think', think: thinking, encrypted: signature }]
      : [{ type: 'think', think: thinking }];
  if (text.length > 0) parts.push({ type: 'text', text });
  return parts;
}

export function makeEndTurnResponse(
  text: string,
  usage: Partial<TokenUsage> = {},
): FakeLLMResponse {
  return {
    toolCalls: [],
    providerFinishReason: 'completed',
    usage: zeroUsage(usage),
    contentParts: makeTextParts(text),
  };
}

export function makeMaxTokensResponse(
  text: string,
  usage: Partial<TokenUsage> = {},
): FakeLLMResponse {
  return {
    toolCalls: [],
    providerFinishReason: 'truncated',
    usage: zeroUsage(usage),
    contentParts: makeTextParts(text),
  };
}

export function makeToolUseResponse(
  toolCalls: ToolCall[],
  usage: Partial<TokenUsage> = {},
): FakeLLMResponse {
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

function providerFinishReasonForStopReason(reason: LoopStepStopReason): FinishReason {
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
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function zeroUsage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

export function makeToolCall(name: string, args: unknown, id?: string): ToolCall {
  return {
    type: 'function',
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
      arguments: JSON.stringify(args),
  };
}
