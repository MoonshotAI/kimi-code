/**
 * `llmProtocol` provider boundary contract — SDK and streamed API failures
 * retain rate-limit classification and server-directed retry metadata.
 */

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import { describe, expect, it } from 'vitest';

import {
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  isRetryableGenerateError,
} from '#/app/llmProtocol/errors';
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

  it('fails fast on a streamed insufficient_quota error event', async () => {
    const stream = new OpenAIResponsesStreamedMessage(
      streamEvents([
        {
          type: 'error',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
          param: null,
        },
      ]),
      true,
    );

    const caught = await consume(stream).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(caught)).toBe(false);
  });
});

describe('OpenAI quota-exhausted 429 conversion', () => {
  const QUOTA_MESSAGE =
    'Your account org-0123456789abcdef <ak-test> is suspended due to insufficient balance, please recharge your account or check your plan and billing details';

  it('classifies a structured exceeded_current_quota_error body as quota-exhausted', () => {
    const source = new OpenAIAPIError(
      429,
      { message: QUOTA_MESSAGE, type: 'exceeded_current_quota_error' },
      `429 ${QUOTA_MESSAGE}`,
      new Headers(),
    );

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('falls back to message wording when no structured body is present', () => {
    const source = new OpenAIAPIError(429, undefined, QUOTA_MESSAGE, new Headers());

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });
});
