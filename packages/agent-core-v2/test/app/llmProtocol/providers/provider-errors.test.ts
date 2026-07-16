/**
 * `llmProtocol` provider boundary contract — SDK and streamed API failures
 * retain rate-limit classification and server-directed retry metadata.
 */

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import { describe, expect, it } from 'vitest';

import { APIProviderRateLimitError, APIStatusError } from '#/app/llmProtocol/errors';
import { convertAnthropicError } from '#/app/llmProtocol/providers/anthropic';
import { convertOpenAIError } from '#/app/llmProtocol/providers/openai-common';
import { OpenAIResponsesStreamedMessage } from '#/app/llmProtocol/providers/openai-responses';

async function* streamEvents(events: readonly Record<string, unknown>[]) {
  yield* events;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of stream) {
    void _part;
  }
}

describe('provider retry-after conversion', () => {
  it('preserves OpenAI retry-after seconds on a rate-limit error', () => {
    const source = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({ 'retry-after': '12' }),
    );

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIProviderRateLimitError).retryAfterMs).toBe(12_000);
  });

  it('preserves the x-trace-id header on a status error', () => {
    const source = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({ 'x-trace-id': 'trace-err-1' }),
    );

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).traceId).toBe('trace-err-1');
  });

  it('leaves the trace id null when the error response has no x-trace-id header', () => {
    const source = new OpenAIAPIError(500, undefined, 'Internal server error', new Headers());

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).traceId).toBeNull();
  });

  it('preserves Anthropic retry-after seconds on a rate-limit error', () => {
    const source = AnthropicAPIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      new Headers({ 'retry-after': '7' }),
    );

    const error = convertAnthropicError(source);

    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIProviderRateLimitError).retryAfterMs).toBe(7_000);
  });
});

describe('OpenAI Responses rate-limit conversion', () => {
  it('promotes an embedded status_code=429 stream error to a rate-limit error', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      streamEvents([
        {
          type: 'error',
          code: 'upstream_error',
          message: 'example.test/responses/response.json status_code=429',
          param: null,
        },
      ]),
      true,
    );

    await expect(consume(stream)).rejects.toBeInstanceOf(APIProviderRateLimitError);
  });
});
