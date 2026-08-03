/**
 * Tests for `tools/cron/persist`.
 *
 * The store itself is a thin wrapper around `createPerIdJsonStore`,
 * which has its own tests covering the FS contract (atomic writes,
 * corrupt-skipping, path-traversal). This file only covers the
 * cron-specific shape guard and a single round-trip to confirm the
 * wiring.
 */

import { describe, expect, it } from 'vitest';

import { CRON_ID_REGEX, isValidCronTask } from '../../../src/tools/cron/persist';
import type { CronTask } from '../../../src/tools/cron/types';

const validTask: CronTask = {
  id: '0123abcd',
  cron: '*/5 * * * *',
  prompt: 'ping',
  createdAt: 1_700_000_000_000,
  recurring: true,
};

describe('CRON_ID_REGEX', () => {
  it('accepts an 8-char lowercase hex id', () => {
    expect(CRON_ID_REGEX.test('00000000')).toBe(true);
    expect(CRON_ID_REGEX.test('0123abcd')).toBe(true);
    expect(CRON_ID_REGEX.test('ffffffff')).toBe(true);
  });

  it('rejects non-hex / wrong-length / uppercase ids', () => {
    expect(CRON_ID_REGEX.test('0123abc')).toBe(false); // 7 chars
    expect(CRON_ID_REGEX.test('0123abcde')).toBe(false); // 9 chars
    expect(CRON_ID_REGEX.test('0123ABCD')).toBe(false); // uppercase
    expect(CRON_ID_REGEX.test('zzzzzzzz')).toBe(false); // non-hex
    expect(CRON_ID_REGEX.test('../etcok')).toBe(false); // path traversal
  });
});

describe('isValidCronTask', () => {
  it('accepts a fully-specified recurring task', () => {
    expect(isValidCronTask(validTask)).toBe(true);
  });

  it('accepts a task with omitted `recurring` (treated as recurring)', () => {
    const { recurring: _omit, ...withoutRecurring } = validTask;
    expect(isValidCronTask(withoutRecurring)).toBe(true);
  });

  it('accepts `recurring: false` (one-shot)', () => {
    expect(isValidCronTask({ ...validTask, recurring: false })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isValidCronTask(null)).toBe(false);
    expect(isValidCronTask(undefined)).toBe(false);
    expect(isValidCronTask('hello')).toBe(false);
    expect(isValidCronTask(42)).toBe(false);
  });

  it('rejects ids that fail CRON_ID_REGEX', () => {
    expect(isValidCronTask({ ...validTask, id: 'NOT-AN-ID' })).toBe(false);
    expect(isValidCronTask({ ...validTask, id: '0123abcde' })).toBe(false);
  });

  it('rejects missing / wrong-type fields', () => {
    const { cron: _c, ...withoutCron } = validTask;
    expect(isValidCronTask(withoutCron)).toBe(false);
    const { prompt: _p, ...withoutPrompt } = validTask;
    expect(isValidCronTask(withoutPrompt)).toBe(false);
    expect(isValidCronTask({ ...validTask, createdAt: 'recent' })).toBe(false);
    expect(isValidCronTask({ ...validTask, recurring: 'yes' })).toBe(false);
  });
});
