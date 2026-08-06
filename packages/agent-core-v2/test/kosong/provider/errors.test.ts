/**
 * `kosong/provider` abort-classification probes (probe 3) — a user
 * cancellation must never be converted into (or returned as) a retryable
 * provider error:
 *
 *  - `convertOpenAIError` / `convertAnthropicError` THROW the standard abort
 *    DOMException for every abort shape (the standard DOMException, a bare
 *    `Error` named `AbortError`, an SDK `APIUserAbortError`) — the guard is a
 *    throw at the front of the classification chain, not a return;
 *  - non-abort errors still classify normally;
 *  - `isRetryableGenerateError` is false for the abort shape.
 *
 * Also probes quota-exhausted classification at the provider boundary. The
 * base converters stay vendor-neutral (only OpenAI's own documented
 * `insufficient_quota` code fails fast there); Moonshot's quota signals are
 * declared on the Kimi traits via the `convertError` hook, composed with
 * last-declarer-wins semantics and consulted — after the abort guard — with
 * the raw failure at every catch seam, including the Responses in-stream
 * error-event path.
 */

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import { describe, expect, it } from 'vitest';

import {
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  ChatProviderError,
  createAbortError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import { traitConvertError, type TraitContext } from '#/kosong/protocol/protocolTrait';
import { convertAnthropicError } from '#/kosong/provider/bases/anthropic/anthropic';
import { convertOpenAIError } from '#/kosong/provider/bases/openai/openai-common';
import { OpenAIResponsesStreamedMessage } from '#/kosong/provider/bases/openai/openai-responses';
import { composeOpenAIChatHooks } from '#/kosong/provider/bases/openai/openaiHooks';
import { kimiAnthropicTrait, kimiOpenAITrait } from '#/kosong/provider/providers/kimi/kimi.contrib';
import { classifyKimiQuotaError } from '#/kosong/provider/providers/kimi/kimi-errors';

const APIUserAbortError = class extends Error {};

function expectStandardAbort(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DOMException);
  expect((thrown as DOMException).name).toBe('AbortError');
}

describe('convertOpenAIError abort guard', () => {
  it('throws the standard abort DOMException for the standard abort shape', () => {
    expectStandardAbort(() => convertOpenAIError(createAbortError()));
  });

  it('throws for a bare Error named AbortError', () => {
    const bare = new Error('aborted');
    bare.name = 'AbortError';
    expectStandardAbort(() => convertOpenAIError(bare));
  });

  it('throws for an SDK APIUserAbortError', () => {
    expectStandardAbort(() => convertOpenAIError(new APIUserAbortError('user aborted')));
  });

  it('never classifies an abort as retryable', () => {
    expect(isRetryableGenerateError(createAbortError())).toBe(false);
  });
});

describe('convertAnthropicError abort guard', () => {
  it('throws the standard abort DOMException for abort shapes', () => {
    expectStandardAbort(() => convertAnthropicError(createAbortError()));
    expectStandardAbort(() => convertAnthropicError(new APIUserAbortError('user aborted')));
  });
});

describe('non-abort classification still works', () => {
  it('passes ChatProviderError through unchanged', () => {
    const original = new ChatProviderError('wire issue');
    expect(convertOpenAIError(original)).toBe(original);
    expect(convertAnthropicError(original)).not.toBeUndefined();
  });

  it('classifies generic errors and keeps status errors retryable', () => {
    const timeout = convertOpenAIError(new Error('request timed out'));
    expect(isRetryableGenerateError(timeout)).toBe(true);

    const status = new APIStatusError(500, 'server error');
    expect(convertOpenAIError(status)).toBe(status);
    expect(isRetryableGenerateError(status)).toBe(true);
  });
});

async function* streamEvents(events: readonly Record<string, unknown>[]) {
  yield* events;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of stream) {
    void _part;
  }
}

const QUOTA_MESSAGE =
  'Your account org-0123456789abcdef <ak-test> is suspended due to insufficient balance, please recharge your account or check your plan and billing details';

const TOKEN_QUOTA_MESSAGE =
  'You exceeded your current token quota: <org-0123456789abcdef> 31275, please check your account balance';

function moonshotQuota429(message: string, type?: string): OpenAIAPIError {
  return new OpenAIAPIError(
    429,
    type === undefined ? undefined : { message, type },
    `429 ${message}`,
    new Headers(),
  );
}

describe('classifyKimiQuotaError (Kimi trait classifier)', () => {
  it('classifies a structured exceeded_current_quota_error body as quota-exhausted', () => {
    const error = classifyKimiQuotaError(
      moonshotQuota429('Too many requests', 'exceeded_current_quota_error'),
    );
    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it.each([QUOTA_MESSAGE, TOKEN_QUOTA_MESSAGE])(
    'falls back to billing wording "%s" when no structured body is present',
    (message) => {
      const error = classifyKimiQuotaError(moonshotQuota429(message));
      expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
      expect(isRetryableGenerateError(error)).toBe(false);
    },
  );

  it.each(['Too many requests', 'your token quota per minute was exceeded'])(
    'answers undefined for transient 429 "%s"',
    (message) => {
      expect(classifyKimiQuotaError(moonshotQuota429(message))).toBeUndefined();
    },
  );

  it('answers undefined for non-429 and non-SDK shapes', () => {
    expect(
      classifyKimiQuotaError(new OpenAIAPIError(403, undefined, QUOTA_MESSAGE, new Headers())),
    ).toBeUndefined();
    expect(classifyKimiQuotaError(new Error(QUOTA_MESSAGE))).toBeUndefined();
    expect(classifyKimiQuotaError(undefined)).toBeUndefined();
  });

  it('classifies the Anthropic SDK error shape (body nested under .error)', () => {
    const source = AnthropicAPIError.generate(
      429,
      { type: 'error', error: { type: 'exceeded_current_quota_error', message: 'quota gone' } },
      'Too many requests',
      new Headers(),
    );
    const error = classifyKimiQuotaError(source);
    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('is declared as the convertError hook on both Kimi traits', () => {
    const context: TraitContext = {
      config: { protocol: 'openai', providerType: 'kimi', modelName: '' } as ProtocolAdapterConfig,
      providerId: 'kimi',
    };
    const source = moonshotQuota429('Too many requests', 'exceeded_current_quota_error');
    expect(kimiOpenAITrait.convertError!(source, context)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
    expect(kimiAnthropicTrait.convertError!(source, context)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
  });
});

describe('convertError hook consult at the OpenAI boundary', () => {
  const kimiContext: TraitContext = {
    config: { protocol: 'openai', providerType: 'kimi', modelName: '' } as ProtocolAdapterConfig,
    providerId: 'kimi',
  };

  it('prefers the composed hook over the vendor-neutral base classification', () => {
    const hooks = composeOpenAIChatHooks([{ trait: kimiOpenAITrait, context: kimiContext }]);
    const source = moonshotQuota429(QUOTA_MESSAGE);

    expect(convertOpenAIError(source)).toBeInstanceOf(APIProviderRateLimitError);
    expect(convertOpenAIError(source, hooks?.convertError)).toBeInstanceOf(
      APIProviderQuotaExhaustedError,
    );
  });

  it('binds convertError with last-declarer-wins semantics', () => {
    const bound = traitConvertError([
      { trait: { convertError: () => new ChatProviderError('first') }, context: kimiContext },
      { trait: { convertError: () => new ChatProviderError('second') }, context: kimiContext },
    ]);
    expect(bound!(new Error('anything'))?.message).toBe('second');
  });

  it('still throws the standard abort shape when a hook is present', () => {
    expectStandardAbort(() =>
      convertOpenAIError(createAbortError(), () => new ChatProviderError('never')),
    );
  });

  it('passes already-converted errors through without re-consulting the hook', () => {
    const calls: unknown[] = [];
    const converted = new APIProviderQuotaExhaustedError('already classified');
    const result = convertOpenAIError(converted, (error) => {
      calls.push(error);
      return new ChatProviderError('re-classified');
    });
    expect(result).toBe(converted);
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAI base quota classification (vendor-neutral)', () => {
  it("fails fast on OpenAI's own insufficient_quota code without any hook", () => {
    const source = new OpenAIAPIError(
      429,
      {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
      },
      '429 You exceeded your current quota, please check your plan and billing details.',
      new Headers(),
    );

    const error = convertOpenAIError(source);

    expect(error).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('keeps vendor billing wordings a retryable rate limit without a hook', () => {
    const error = convertOpenAIError(moonshotQuota429(QUOTA_MESSAGE));
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(isRetryableGenerateError(error)).toBe(true);
  });
});

describe('OpenAI Responses quota-exhausted conversion', () => {
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

  it('consults a convertError hook with the raw in-stream error event', async () => {
    const seen: unknown[] = [];
    const stream = new OpenAIResponsesStreamedMessage(
      streamEvents([
        {
          type: 'error',
          code: 'vendor_quota_gone',
          message: 'vendor says the quota is gone',
          param: null,
        },
      ]),
      true,
      (error) => {
        seen.push(error);
        return (error as { code?: string }).code === 'vendor_quota_gone'
          ? new APIProviderQuotaExhaustedError('vendor quota exhausted')
          : undefined;
      },
    );

    const caught = await consume(stream).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect((caught as APIProviderQuotaExhaustedError).message).toBe('vendor quota exhausted');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', code: 'vendor_quota_gone' });
  });
});
