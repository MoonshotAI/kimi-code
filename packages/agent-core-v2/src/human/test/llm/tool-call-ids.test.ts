import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  isToolCall,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#/llm/message';
import { sanitizeToolCallId } from '#/llm/protocol/kit/ids';
import { createToolCallIdNormalizer } from '#/llm/protocol/rules/tool-call-ids';
import { createRequester as createCoreRequester } from '#/llm/requester';

function call(id: string, streamIndex?: number, rawId?: string): ToolCall {
  return { type: 'function', id, name: 'Bash', arguments: '{}', _streamIndex: streamIndex, rawId };
}

function historyWith(...ids: string[]): Message[] {
  return [createAssistantMessage([], ids.map((id) => call(id)))];
}

function policy(maxLength: number) {
  return {
    normalize: (id: string) => sanitizeToolCallId(id, maxLength),
    maxLength,
  };
}

function withResponseStream(chunks: readonly Record<string, unknown>[]) {
  return {
    withResponse: async () => ({
      data: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      },
      response: new Response(null),
    }),
  };
}

describe('LLM tool call id normalization', () => {
  it('passes safe first-seen ids through unchanged and legalizes invalid ids', () => {
    const normalizer = createToolCallIdNormalizer([]);
    const first = call('call_1', 0, 'provider-original');
    const second = call('call_2', 1);
    expect(normalizer.normalizePart(first)).toBe(first);
    expect(normalizer.normalizePart(second)).toBe(second);

    const constrained = createToolCallIdNormalizer([], policy(8));
    expect(constrained.normalizePart(call('a b', 0))).toMatchObject({ id: 'a_b', rawId: 'a b' });
    expect(constrained.normalizePart(call('', 1))).toMatchObject({ id: 'tool_cal', rawId: '' });
  });

  it('rewrites ids claimed by earlier responses from request history', () => {
    const second = createToolCallIdNormalizer(historyWith('Bash_0'));
    expect(second.normalizePart(call('Bash_0', 0))).toMatchObject({
      id: 'Bash_0__2',
      rawId: 'Bash_0',
    });

    const third = createToolCallIdNormalizer(historyWith('Bash_0', 'Bash_0__2'));
    expect(third.normalizePart(call('Bash_0', 0))).toMatchObject({
      id: 'Bash_0__3',
      rawId: 'Bash_0',
    });
  });

  it('keeps duplicate stream and finalized assignments consistent within max length', () => {
    const normalizer = createToolCallIdNormalizer([]);
    const first = normalizer.normalizePart(call('Bash_0', 0));
    const second = normalizer.normalizePart(call('Bash_0', 1));
    expect(normalizer.normalizePart(call('Bash_0', 1))).toEqual(second);
    const message = createAssistantMessage([], [first, second] as ToolCall[]);
    const finished = normalizer.finish(message);
    expect(finished).toBe(message);
    expect(finished.toolCalls.map((call) => [call.id, call.rawId])).toEqual([
      ['Bash_0', undefined],
      ['Bash_0__2', 'Bash_0'],
    ]);
    expect(normalizer.finish(finished)).toBe(finished);
    const rawFinal = normalizer.finish(createAssistantMessage([], [call('Bash_0'), call('Bash_0')]));
    expect(rawFinal.toolCalls.map((call) => [call.id, call.rawId])).toEqual([
      ['Bash_0', undefined],
      ['Bash_0__2', 'Bash_0'],
    ]);

    const constrained = createToolCallIdNormalizer([], policy(10));
    constrained.normalizePart(call('a'.repeat(20), 0));
    expect(constrained.normalizePart(call('a'.repeat(20), 1)).id).toBe('aaaaaaa__2');
  });

  it('seeds taken ids from legalized restored context', () => {
    const normalizer = createToolCallIdNormalizer(historyWith('bad id'), policy(64));
    expect(normalizer.normalizePart(call('bad id', 0))).toMatchObject({
      id: 'bad_id__2',
      rawId: 'bad id',
    });
    const ignored = call('ignored', 1);
    expect(normalizer.normalizePart(ignored)).toBe(ignored);
  });

  it('claims tool result ids from history as well', () => {
    const normalizer = createToolCallIdNormalizer([
      createUserMessage('hi'),
      createToolMessage('Bash_1', 'done'),
    ]);
    expect(normalizer.normalizePart(call('Bash_1', 0))).toMatchObject({
      id: 'Bash_1__2',
      rawId: 'Bash_1',
    });
  });

  it('reuses deterministic assignments for a fresh retry attempt', () => {
    const history = historyWith('Bash_0');
    const failed = createToolCallIdNormalizer(history);
    const retry = createToolCallIdNormalizer(history);
    expect(failed.normalizePart(call('Bash_0', 0))).toEqual(retry.normalizePart(call('Bash_0', 0)));
  });

  it('does not leak failed attempt claims into later attempts', () => {
    const failed = createToolCallIdNormalizer([]);
    failed.normalizePart(call('Bash_0', 0));

    const next = createToolCallIdNormalizer([]);
    const raw = call('Bash_0', 0);
    expect(next.normalizePart(raw)).toBe(raw);

    const committed = createToolCallIdNormalizer(historyWith('Bash_0'));
    expect(committed.normalizePart(call('Bash_0', 0))).toMatchObject({
      id: 'Bash_0__2',
      rawId: 'Bash_0',
    });
  });

  it('mints ids for finalized calls that never streamed a part', () => {
    const normalizer = createToolCallIdNormalizer([]);
    const streamed = normalizer.normalizePart(call('Bash_0', 0));
    const message = createAssistantMessage([], [streamed, call('late_1'), call('late_1')] as ToolCall[]);
    const finished = normalizer.finish(message);
    expect(finished.toolCalls.map((call) => [call.id, call.rawId])).toEqual([
      ['Bash_0', undefined],
      ['late_1', undefined],
      ['late_1__2', 'late_1'],
    ]);
    expect(normalizer.finish(finished)).toBe(finished);
    expect(normalizer.finish(message)).toBe(finished);
  });

  it('normalizes direct requester events and final outcome through settle', async () => {
    const chunks = [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Bash', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];
    const requester = createCoreRequester().with({
      protocol: { base: openAIProtocol },
      endpoint: {
        baseUrl: 'https://example.test/v1',
        clientFactory: () => ({
          chat: { completions: { create: () => withResponseStream(chunks) } },
        }),
      },
    });
    const parts: StreamedMessagePart[] = [];
    const outcome = await requester.generate(
      {
        model: { spec: { provider: 'openai', name: 'test-model' } },
        content: {
          messages: [
            createUserMessage('hi'),
            createAssistantMessage([], [call('call_1')]),
            createToolMessage('call_1', 'done'),
          ],
        },
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') parts.push(event.part);
        },
      },
    );

    expect(parts.filter(isToolCall).map((part) => [part.id, part.rawId])).toEqual([
      ['call_1__2', 'call_1'],
    ]);
    expect(outcome.type).toBe('done');
    if (outcome.type !== 'done') throw new Error('expected done outcome');
    expect(outcome.message.toolCalls.map((call) => [call.id, call.rawId])).toEqual([
      ['call_1__2', 'call_1'],
    ]);
  });
});
