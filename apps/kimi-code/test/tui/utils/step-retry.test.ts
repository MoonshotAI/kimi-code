import { describe, expect, it } from 'vitest';

import { RETRY_DETAIL_MAX_CHARS } from '#/tui/constant/rendering';
import { formatStepRetryDetail, formatStepRetryLabel } from '#/tui/utils/step-retry';
import type { StepRetryState } from '#/tui/types';

function retry(partial: Partial<StepRetryState> = {}): StepRetryState {
  return {
    nextAttempt: 2,
    maxAttempts: 10,
    delayMs: 4000,
    errorName: 'APIStatusError',
    errorMessage: 'rate limited',
    statusCode: 429,
    phase: 'backoff',
    ...partial,
  };
}

describe('formatStepRetryLabel', () => {
  it('shows attempts, raw error name, and backoff delay', () => {
    expect(formatStepRetryLabel(retry())).toBe('Retrying (2/10) · APIStatusError · in 4s');
  });

  it('drops the stale countdown once the attempt is running', () => {
    expect(formatStepRetryLabel(retry({ phase: 'attempt' }))).toBe(
      'Retrying (2/10) · APIStatusError',
    );
  });

  it('rounds sub-second delays up to 1s', () => {
    expect(formatStepRetryLabel(retry({ delayMs: 500 }))).toContain('in 1s');
  });
});

describe('formatStepRetryDetail', () => {
  it('prefixes the message with the status code', () => {
    expect(formatStepRetryDetail(retry())).toBe('429 · rate limited');
  });

  it('omits the status code for network/timeout failures', () => {
    expect(
      formatStepRetryDetail(
        retry({ errorName: 'APIConnectionError', errorMessage: 'fetch failed', statusCode: undefined }),
      ),
    ).toBe('fetch failed');
  });

  it('collapses multi-line error bodies into one line', () => {
    expect(formatStepRetryDetail(retry({ errorMessage: 'line one\n\n  line two' }))).toBe(
      '429 · line one line two',
    );
  });

  it('caps huge error bodies', () => {
    const detail = formatStepRetryDetail(retry({ errorMessage: 'x'.repeat(1000) }));
    expect(detail.length).toBe(RETRY_DETAIL_MAX_CHARS);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('returns the status code alone when the message is empty', () => {
    expect(formatStepRetryDetail(retry({ errorMessage: '' }))).toBe('429');
  });
});
