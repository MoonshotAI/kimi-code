/**
 * `llmProtocol` OpenAI Responses streaming contract — final tool arguments
 * override provisional deltas without leaking partial values or mixing calls.
 */

import { describe, expect, it, vi } from 'vitest';

import { ChatProviderError } from '#/app/llmProtocol/errors';
import { generate } from '#/app/llmProtocol/generate';
import type { StreamedMessagePart, ToolCall } from '#/app/llmProtocol/message';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '#/app/llmProtocol/providers/openai-responses';

describe('OpenAI Responses authoritative function-call arguments', () => {
  it('uses function_call_arguments.done when it corrects streamed deltas', async () => {
    const events = [
      functionCallAdded('item_corrected', 'call_corrected', 'add'),
      functionArgumentsDelta('item_corrected', '{"a":1}'),
      functionArgumentsDone('item_corrected', '{"a":2}'),
    ];

    await expect(
      collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
    ).resolves.toEqual([
      indexedToolCall('item_corrected', 'call_corrected', 'add'),
      indexedArguments('item_corrected', '{"a":2}'),
    ]);
  });

  it('prefers output_item.done over function_call_arguments.done and buffered deltas', async () => {
    const events = [
      functionCallAdded('item_precedence', 'call_precedence', 'add', '{"draft":'),
      functionArgumentsDelta('item_precedence', '1}'),
      functionArgumentsDone('item_precedence', '{"source":"function-done"}'),
      functionCallOutputDone('item_precedence', '{"source":"output-item"}'),
    ];

    await expect(
      collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
    ).resolves.toEqual([
      indexedToolCall('item_precedence', 'call_precedence', 'add'),
      indexedArguments('item_precedence', '{"source":"output-item"}'),
    ]);
  });

  it.each(['response.completed', 'response.incomplete'] as const)(
    '%s waits for normal EOF before emitting accumulated fallback arguments',
    async (terminationType) => {
      const terminationEvent =
        terminationType === 'response.completed'
          ? {
              type: terminationType,
              response: { id: 'resp_eof', status: 'completed' },
            }
          : {
              type: terminationType,
              response: {
                id: 'resp_eof',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
              },
            };
      const controlled = controlledEOFIterable([
        functionCallAdded('item_eof', 'call_eof', 'add', '{"a":'),
        functionArgumentsDelta('item_eof', '1}'),
        terminationEvent,
      ]);
      const iterator = new OpenAIResponsesStreamedMessage(
        controlled.iterable,
        true,
      )[Symbol.asyncIterator]();

      expect(await iterator.next()).toEqual({
        done: false,
        value: indexedToolCall('item_eof', 'call_eof', 'add'),
      });

      let settled = false;
      const fallback = iterator.next().then((result) => {
        settled = true;
        return result;
      });
      await controlled.waitingForEOF;
      expect(settled).toBe(false);

      controlled.finish();
      expect(await fallback).toEqual({
        done: false,
        value: indexedArguments('item_eof', '{"a":1}'),
      });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    },
  );

  it.each([
    ['equal', '{"a":1}', '', '{"a":1}'],
    ['prefix extension', '{"a":', '', '{"a":1}'],
  ])('emits one complete part for a %s function-done final', async (_label, delta, initial, final) => {
    const events = [
      functionCallAdded('item_compat', 'call_compat', 'add', initial),
      functionArgumentsDelta('item_compat', delta),
      functionArgumentsDone('item_compat', final),
    ];

    await expect(
      collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
    ).resolves.toEqual([
      indexedToolCall('item_compat', 'call_compat', 'add'),
      indexedArguments('item_compat', final),
    ]);
  });

  it.each([
    ['missing', {}],
    ['null', { arguments: null }],
  ])(
    'falls back to function-done arguments when output_item.done arguments are %s',
    async (_label, outputFields) => {
      const events = [
        functionCallAdded('item_null', 'call_null', 'add'),
        functionArgumentsDelta('item_null', '{"draft":true}'),
        functionArgumentsDone('item_null', '{"final":true}'),
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'item_null', ...outputFields },
        },
      ];

      await expect(
        collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
      ).resolves.toEqual([
        indexedToolCall('item_null', 'call_null', 'add'),
        indexedArguments('item_null', '{"final":true}'),
      ]);
    },
  );

  it('keeps parallel calls isolated and preserves header order after reverse completion', async () => {
    const events = [
      functionCallAdded('item_a', 'call_a', 'add', '{"draft":'),
      functionCallAdded('item_b', 'call_b', 'multiply'),
      functionArgumentsDelta('item_a', '1}'),
      functionArgumentsDelta('item_b', '{"draft":2}'),
      functionArgumentsDone('item_a', '{"a":1}'),
      functionArgumentsDone('item_b', '{"b":2}'),
      functionCallOutputDone('item_b', '{"b":20}'),
      functionCallOutputDone('item_a', '{"a":10}'),
    ];
    const rawParts: StreamedMessagePart[] = [];

    const result = await generate(
      streamingProvider(events),
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'run tools' }], toolCalls: [] }],
      {
        onMessagePart: (part) => {
          rawParts.push(part);
        },
      },
    );

    expect(rawParts).toEqual([
      indexedToolCall('item_a', 'call_a', 'add'),
      indexedToolCall('item_b', 'call_b', 'multiply'),
      indexedArguments('item_b', '{"b":20}'),
      indexedArguments('item_a', '{"a":10}'),
    ]);
    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'call_a',
        name: 'add',
        arguments: '{"a":10}',
        extras: undefined,
      },
      {
        type: 'function',
        id: 'call_b',
        name: 'multiply',
        arguments: '{"b":20}',
        extras: undefined,
      },
    ]);
  });

  it.each([
    ['delta', functionArgumentsDelta('missing_item', '{}')],
    ['done', functionArgumentsDone('missing_item', '{}')],
  ])('rejects %s arguments for an unknown stream index', async (_label, event) => {
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable([event]), true);
    await expect(collectStreamParts(stream)).rejects.toThrow(/unknown stream index missing_item/);
  });

  it('buffers an unindexed call as a whole call across intervening text and reasoning', async () => {
    const events = [
      functionCallAdded(undefined, 'call_unindexed', 'add'),
      functionArgumentsDelta(undefined, '{"draft":1}'),
      { type: 'response.output_text.delta', delta: 'between' },
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      functionCallOutputDone(undefined, '{"final":2}'),
    ];

    await expect(
      collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
    ).resolves.toEqual([
      { type: 'text', text: 'between' },
      { type: 'think', think: 'thinking' },
      {
        type: 'function',
        id: 'call_unindexed',
        name: 'add',
        arguments: '{"final":2}',
      },
    ]);
  });

  it.each([
    ['another unindexed', undefined],
    ['an indexed', 'item_later'],
  ])('rejects %s function-call header while an unindexed call is unresolved', async (_label, id) => {
    const events = [
      functionCallAdded(undefined, 'call_unindexed', 'add'),
      { type: 'response.output_text.delta', delta: 'between' },
      functionCallAdded(id, 'call_later', 'multiply'),
    ];
    const { parts, error } = await collectPartsAndError(
      new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true),
    );

    expect(parts).toEqual([{ type: 'text', text: 'between' }]);
    expect(error).toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toMatch(/unindexed function call.*unresolved/i);
  });

  it('allows a sequential unindexed call after the prior call commits', async () => {
    const events = [
      functionCallAdded(undefined, 'call_first', 'add'),
      functionCallOutputDone(undefined, '{"first":1}'),
      functionCallAdded(undefined, 'call_second', 'multiply'),
      functionCallOutputDone(undefined, '{"second":2}'),
    ];

    await expect(
      collectStreamParts(new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true)),
    ).resolves.toEqual([
      { type: 'function', id: 'call_first', name: 'add', arguments: '{"first":1}' },
      {
        type: 'function',
        id: 'call_second',
        name: 'multiply',
        arguments: '{"second":2}',
      },
    ]);
  });

  it.each([
    [
      'error',
      { type: 'error', code: 'server_error', message: 'upstream failed', param: null },
    ],
    [
      'response.failed',
      {
        type: 'response.failed',
        response: {
          id: 'resp_failed',
          status: 'failed',
          error: { code: 'server_error', message: 'upstream failed' },
        },
      },
    ],
    ['decode failure', { type: 42 }],
  ])('%s does not flush buffered arguments', async (_label, failureEvent) => {
    const events = [
      functionCallAdded('item_failure', 'call_failure', 'add'),
      functionArgumentsDelta('item_failure', '{"partial":'),
      failureEvent,
    ];
    const { parts, error } = await collectPartsAndError(
      new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true),
    );

    expect(parts).toEqual([indexedToolCall('item_failure', 'call_failure', 'add')]);
    expect(error).toBeInstanceOf(Error);
  });

  it('does not flush buffered arguments when the source iterator throws', async () => {
    async function* failingEvents(): AsyncIterable<Record<string, unknown>> {
      yield functionCallAdded('item_throw', 'call_throw', 'add');
      yield functionArgumentsDelta('item_throw', '{"partial":');
      throw new Error('iterator boom');
    }
    const { parts, error } = await collectPartsAndError(
      new OpenAIResponsesStreamedMessage(failingEvents(), true),
    );

    expect(parts).toEqual([indexedToolCall('item_throw', 'call_throw', 'add')]);
    expect((error as Error).message).toContain('iterator boom');
  });

  it('does not flush buffered arguments when the consumer returns early', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      makeAsyncIterable([
        functionCallAdded('item_cancel', 'call_cancel', 'add', '{"initial":true}'),
        functionArgumentsDelta('item_cancel', '{"partial":'),
      ]),
      true,
    );
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: indexedToolCall('item_cancel', 'call_cancel', 'add'),
    });
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
  });
});

async function collectStreamParts(
  stream: OpenAIResponsesStreamedMessage,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function makeAsyncIterable(
  events: Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<Record<string, unknown>>> {
          if (index < events.length) {
            return Promise.resolve({ value: events[index++]!, done: false });
          }
          return Promise.resolve({
            value: undefined as unknown as Record<string, unknown>,
            done: true,
          });
        },
      };
    },
  };
}

function functionCallAdded(
  itemId: string | undefined,
  callId: string,
  name: string,
  argumentsValue: string = '',
): Record<string, unknown> {
  return {
    type: 'response.output_item.added',
    item: {
      id: itemId,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: argumentsValue,
    },
  };
}

function functionArgumentsDelta(
  itemId: string | undefined,
  delta: string,
): Record<string, unknown> {
  return { type: 'response.function_call_arguments.delta', item_id: itemId, delta };
}

function functionArgumentsDone(
  itemId: string | undefined,
  argumentsValue: string,
): Record<string, unknown> {
  return {
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    arguments: argumentsValue,
  };
}

function functionCallOutputDone(
  itemId: string | undefined,
  argumentsValue: string,
): Record<string, unknown> {
  return {
    type: 'response.output_item.done',
    item: { id: itemId, type: 'function_call', arguments: argumentsValue },
  };
}

function indexedToolCall(index: string, id: string, name: string): ToolCall {
  return { type: 'function', id, name, arguments: null, _streamIndex: index };
}

function indexedArguments(index: string, argumentsPart: string): StreamedMessagePart {
  return { type: 'tool_call_part', argumentsPart, index };
}

function streamingProvider(events: Record<string, unknown>[]): OpenAIResponsesChatProvider {
  const create = vi.fn().mockResolvedValue(makeAsyncIterable(events));
  return new OpenAIResponsesChatProvider({
    model: 'gpt-5',
    apiKey: '',
    clientFactory: () => ({ responses: { create } }) as never,
  });
}

async function collectPartsAndError(
  stream: OpenAIResponsesStreamedMessage,
): Promise<{ parts: StreamedMessagePart[]; error: unknown }> {
  const parts: StreamedMessagePart[] = [];
  let caughtError: unknown;
  try {
    for await (const part of stream) parts.push(part);
  } catch (error) {
    caughtError = error;
  }
  return { parts, error: caughtError };
}

function controlledEOFIterable(events: Record<string, unknown>[]): {
  iterable: AsyncIterable<Record<string, unknown>>;
  waitingForEOF: Promise<void>;
  finish: () => void;
} {
  let index = 0;
  let finish: () => void = () => undefined;
  let notifyWaiting: () => void = () => undefined;
  const waitingForEOF = new Promise<void>((resolve) => {
    notifyWaiting = resolve;
  });
  const eof = new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
    finish = () => {
      resolve({
        value: undefined as unknown as Record<string, unknown>,
        done: true,
      });
    };
  });

  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
        return {
          next(): Promise<IteratorResult<Record<string, unknown>>> {
            if (index < events.length) {
              return Promise.resolve({ value: events[index++]!, done: false });
            }
            notifyWaiting();
            return eof;
          },
        };
      },
    },
    waitingForEOF,
    finish,
  };
}
