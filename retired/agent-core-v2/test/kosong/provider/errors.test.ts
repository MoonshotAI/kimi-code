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
 */

import { describe, expect, it } from 'vitest';

import {
  APIStatusError,
  ChatProviderError,
  createAbortError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { convertAnthropicError } from '#/kosong/provider/bases/anthropic/anthropic';
import { convertOpenAIError } from '#/kosong/provider/bases/openai/openai-common';

// Structurally an SDK user-abort: recognized by constructor name, the same
// way the OpenAI and Anthropic SDKs name their abort error class.
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
