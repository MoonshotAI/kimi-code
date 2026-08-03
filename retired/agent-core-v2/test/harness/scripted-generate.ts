import { type FinishReason } from '#/kosong/contract/provider';
import { isContentPart, isToolCall, type Message, type StreamedMessagePart } from '#/kosong/contract/message';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';

import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import {
  generateInputSnapshot,
  generateInputsSnapshot,
  normalizeGenerateInput,
  type GenerateCall,
} from './snapshots';

type GenerateFn = typeof kosongGenerate;

interface ScriptedResponse {
  readonly parts: readonly StreamedMessagePart[];
  readonly finishReason?: FinishReason | null | undefined;
  readonly rawFinishReason?: string | null | undefined;
  readonly traceId?: string | null | undefined;
}

export function createScriptedGenerate() {
  const calls: GenerateCall[] = [];
  const responses: ScriptedResponse[] = [];
  let assertedCallCount = 0;

  function mockNextResponse(...response: StreamedMessagePart[]) {
    responses.push({ parts: structuredClone(response) });
  }

  function mockNextProviderResponse(input: {
    readonly parts?: readonly StreamedMessagePart[] | undefined;
    readonly finishReason?: FinishReason | null | undefined;
    readonly rawFinishReason?: string | null | undefined;
    readonly traceId?: string | null | undefined;
  }) {
    responses.push({
      parts: structuredClone(input.parts ?? []),
      ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
      ...(input.rawFinishReason !== undefined ? { rawFinishReason: input.rawFinishReason } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    });
  }

  const generate: GenerateFn = async (_chat, systemPrompt, tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`Unexpected generate call #${String(calls.length + 1)}`);
    }
    options?.onTraceId?.(response.traceId ?? null);

    const input = normalizeGenerateInput({
      systemPrompt,
      tools: tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      history: structuredClone(history),
    });
    calls.push(input);

    const content = response.parts.filter((part) => isContentPart(part));
    const toolCalls = response.parts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(content),
      toolCalls: structuredClone(toolCalls),
    };

    for (const part of response.parts) {
      await callbacks?.onMessagePart?.(structuredClone(part));
      options?.signal?.throwIfAborted();
    }
    options?.onStreamEnd?.();

    const inferredFinishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'completed';
    const finishReason = response.finishReason ?? inferredFinishReason;
    return {
      id: `mock-${String(calls.length)}`,
      message,
      usage: {
        inputOther: estimateTokensForMessages(normalizeMessagesForTokenEstimates(history)),
        output: estimateTokensForMessages(normalizeMessagesForTokenEstimates([message])),
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason,
      rawFinishReason: response.rawFinishReason ?? defaultRawFinishReason(finishReason),
      traceId: response.traceId ?? null,
    };
  };

  return {
    generate,
    calls,
    lastInput() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM input. Call ctx.lastLlmInput() after an LLM call.');
      }
      if (pendingCount > 1) {
        throw new Error(
          `Expected one unasserted LLM input, but ${String(pendingCount)} were produced. ` +
            'Call ctx.lastLlmInput() after each LLM call.',
        );
      }

      assertedCallCount = calls.length;
      return generateInputSnapshot(calls.at(-1)!, calls.at(-2));
    },
    inputs() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM inputs. Call ctx.llmInputs() after LLM calls.');
      }

      const pending = calls.slice(assertedCallCount);
      const previous = calls[assertedCallCount - 1];
      assertedCallCount = calls.length;
      return generateInputsSnapshot(pending, previous);
    },
    mockNextResponse,
    mockNextProviderResponse,
  };
}

function normalizeMessagesForTokenEstimates(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((part) =>
      part.type === 'text'
        ? {
            ...part,
            text: part.text.replaceAll(/^Plan file: .+$/gm, 'Plan file: <plan-file>'),
          }
        : part,
    ),
  }));
}

function defaultRawFinishReason(finishReason: FinishReason | null): string | null {
  if (finishReason === null) return null;
  if (finishReason === 'completed') return 'stop';
  return finishReason;
}
