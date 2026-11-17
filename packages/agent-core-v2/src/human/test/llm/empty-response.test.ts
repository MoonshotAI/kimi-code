import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm-requester/capability';
import { NO_FINISH } from '#/llm-requester/finish-reason';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { createUserMessage } from '#/llm/message';
import { createRequester as createCoreRequester } from '#/llm/requester';
import {
  createMessageAccumulator,
  type AssistantMessage,
  type StreamedMessagePart,
} from '#/message';
import type { LlmModel } from '#/llm-requester/model';
import { emptyResponseError } from '#/llm-requester/empty-response';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) {
    accumulator.push(part);
  }
  return accumulator.finish();
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

async function generateOpenAI(
  attempts: readonly (readonly Record<string, unknown>[])[],
  infiniteRetry = false,
) {
  let calls = 0;
  const requester = createCoreRequester().with({
    protocol: { base: openAIProtocol },
    endpoint: {
      baseUrl: 'https://example.test/v1',
      clientFactory: () => {
        const chunks = attempts[calls++];
        if (chunks === undefined) throw new Error('unexpected request attempt');
        return {
          chat: { completions: { create: () => withResponseStream(chunks) } },
        };
      },
    },
  });
  const outcome = await requester.generate(
    {
      model: { spec: { provider: 'openai', name: 'test-model' } },
      content: { messages: [createUserMessage('hi')] },
      policy: { retry: { maxAttemptsPerStep: 1, infiniteRetry } },
    },
    { signal: new AbortController().signal },
  );
  return { calls, outcome };
}

describe('emptyResponseError', () => {
  it('reports an empty response when the stream produced nothing', async () => {
    const message = accumulatedMessage([]);
    const error = emptyResponseError(message, model, NO_FINISH);
    expect(error).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
      retryable: true,
    });
    expect(error?.message).toContain('empty response (no content, no tool calls)');
    expect(error?.message).toContain('Provider: test, model: test-model');

    const filtered = emptyResponseError(message, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered).toMatchObject({
      kind: 'empty_response',
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
      retryable: false,
    });
    expect(filtered?.message).toContain('filtered the response');
    await expect(generateOpenAI([[]])).resolves.toMatchObject({
      calls: 1,
      outcome: { type: 'failed', error: { kind: 'empty_response', retryable: true } },
    });
  });

  it('distinguishes think-only and whitespace responses', async () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const error = emptyResponseError(thinkOnly, model, NO_FINISH);
    expect(error?.kind).toBe('empty_response');
    expect(error?.message).toContain('only thinking content');

    const whitespace = accumulatedMessage([{ type: 'text', text: '  \n' }]);
    expect(emptyResponseError(whitespace, model, NO_FINISH)).toBeNull();

    const thinkWithWhitespace = accumulatedMessage([
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: ' ' },
    ]);
    expect(emptyResponseError(thinkWithWhitespace, model, NO_FINISH)?.message).toContain(
      'only thinking content',
    );
    await expect(
      generateOpenAI([
        [{ choices: [{ delta: { reasoning_content: 'reasoning' }, finish_reason: null }] }],
      ]),
    ).resolves.toMatchObject({
      calls: 1,
      outcome: { type: 'failed', error: { kind: 'empty_response', retryable: true } },
    });
  });

  it('rejects repeated or incomplete responses and preserves completed output', async () => {
    const text = accumulatedMessage([{ type: 'text', text: 'hi' }]);
    const toolCall = accumulatedMessage([
      { type: 'function', id: 'call_1', name: 'tool', arguments: '{}' },
    ]);
    expect(emptyResponseError(text, model, NO_FINISH)).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
    expect(emptyResponseError(toolCall, model, NO_FINISH)).toBeNull();

    for (const message of [text, toolCall]) {
      expect(
        emptyResponseError(message, model, {
          finishReason: 'other',
          rawFinishReason: 'repeat',
        }),
      ).toMatchObject({
        kind: 'empty_response',
        rawFinishReason: 'repeat',
        retryable: true,
        message: expect.stringContaining('repeated output'),
      });
    }

    await expect(
      generateOpenAI([
        [{ choices: [{ delta: { content: 'repeated text' }, finish_reason: 'repeat' }] }],
      ]),
    ).resolves.toMatchObject({
      calls: 1,
      outcome: {
        type: 'failed',
        error: {
          kind: 'empty_response',
          rawFinishReason: 'repeat',
          retryable: true,
          message: expect.stringContaining('repeated output'),
        },
      },
    });

    const incompleteAttempts = [
      [{ choices: [{ delta: { content: 'Let me write the report.' }, finish_reason: null }] }],
      [{ choices: [{ delta: { content: '  \n' }, finish_reason: null }] }],
      [{
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Write', arguments: '{"path":' } }],
          },
          finish_reason: null,
        }],
      }],
    ];
    for (const chunks of incompleteAttempts) {
      await expect(generateOpenAI([chunks])).resolves.toMatchObject({
        calls: 1,
        outcome: {
          type: 'failed',
          error: {
            kind: 'provider',
            retryable: true,
            message: expect.stringContaining('without a finish event'),
          },
        },
      });
    }

    await expect(
      generateOpenAI([
        [{ choices: [{ delta: { content: 'Let me write the report.' }, finish_reason: null }] }],
        [
          { choices: [{ delta: { content: 'completed' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
      ], true),
    ).resolves.toMatchObject({
      calls: 2,
      outcome: {
        type: 'done',
        finish: { finishReason: 'completed', rawFinishReason: 'stop' },
        message: { content: [{ type: 'text', text: 'completed' }] },
      },
    });
  });
});
