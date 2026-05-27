/**
 * Tests for `tools/cron/clock.ts`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { resolveClockSources, SYSTEM_CLOCKS } from '../../../src/tools/cron/clock';

describe('clock.ts', () => {
  describe('SYSTEM_CLOCKS', () => {
    it('monoNowMs is strictly non-decreasing across 1000 calls', () => {
      let prev = SYSTEM_CLOCKS.monoNowMs();
      for (let i = 0; i < 1000; i++) {
        const next = SYSTEM_CLOCKS.monoNowMs();
        expect(next).toBeGreaterThanOrEqual(prev);
        prev = next;
      }
    });

    it('wallNow is close to Date.now', () => {
      const before = Date.now();
      const sample = SYSTEM_CLOCKS.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('monoNowMs returns finite positive numbers', () => {
      const sample = SYSTEM_CLOCKS.monoNowMs();
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThan(0);
    });
  });

  describe('resolveClockSources — default / system', () => {
    it('undefined spec returns SYSTEM_CLOCKS', () => {
      expect(resolveClockSources(undefined)).toBe(SYSTEM_CLOCKS);
    });

    it('empty string returns SYSTEM_CLOCKS', () => {
      expect(resolveClockSources('')).toBe(SYSTEM_CLOCKS);
    });

    it('"system" returns SYSTEM_CLOCKS', () => {
      expect(resolveClockSources('system')).toBe(SYSTEM_CLOCKS);
    });

    it('unrecognised scheme falls back to SYSTEM_CLOCKS', () => {
      expect(resolveClockSources('garbage:foo')).toBe(SYSTEM_CLOCKS);
      expect(resolveClockSources('foobar')).toBe(SYSTEM_CLOCKS);
    });
  });

  describe('resolveClockSources — env:VAR', () => {
    const ENV_VAR = '__KIMI_CRON_CLOCK_TEST_FAKE_NOW__';

    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it('reads process.env on every wallNow call', () => {
      const clocks = resolveClockSources(`env:${ENV_VAR}`);

      process.env[ENV_VAR] = '1000';
      expect(clocks.wallNow()).toBe(1000);

      process.env[ENV_VAR] = '2000';
      expect(clocks.wallNow()).toBe(2000);

      process.env[ENV_VAR] = '3500';
      expect(clocks.wallNow()).toBe(3500);
    });

    it('monoNowMs is not affected by env clock', () => {
      const clocks = resolveClockSources(`env:${ENV_VAR}`);
      process.env[ENV_VAR] = '1000';
      // mono must still be a real, finite, growing number — not the
      // env value.
      const a = clocks.monoNowMs();
      const b = clocks.monoNowMs();
      expect(a).not.toBe(1000);
      expect(b).toBeGreaterThanOrEqual(a);
    });

    it('missing env var falls back to Date.now for that call', () => {
      const clocks = resolveClockSources(`env:${ENV_VAR}`);
      // ENV_VAR intentionally unset.
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('unparseable env value falls back to Date.now for that call', () => {
      const clocks = resolveClockSources(`env:${ENV_VAR}`);
      process.env[ENV_VAR] = 'not-a-number';
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('empty env value falls back to Date.now', () => {
      const clocks = resolveClockSources(`env:${ENV_VAR}`);
      process.env[ENV_VAR] = '';
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('empty env var name in spec falls back to SYSTEM_CLOCKS', () => {
      expect(resolveClockSources('env:')).toBe(SYSTEM_CLOCKS);
    });
  });

  describe('resolveClockSources — file:<path>', () => {
    it('reads file first line on every wallNow call', () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');

      writeFileSync(filePath, '1000\n', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);
      expect(clocks.wallNow()).toBe(1000);

      writeFileSync(filePath, '2500', 'utf8');
      expect(clocks.wallNow()).toBe(2500);

      // Multi-line — only first line counts.
      writeFileSync(filePath, '4242\ngarbage\n', 'utf8');
      expect(clocks.wallNow()).toBe(4242);
    });

    it('missing file falls back to Date.now', () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'never-created.txt');
      const clocks = resolveClockSources(`file:${filePath}`);
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('unparseable content falls back to Date.now', () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, 'not-a-number\n', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('empty file falls back to Date.now', () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, '', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);
      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('monoNowMs is not affected by file clock', () => {
      const tmpDir = mkdtempSync(join(os.tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, '1000', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);
      const a = clocks.monoNowMs();
      const b = clocks.monoNowMs();
      expect(a).not.toBe(1000);
      expect(b).toBeGreaterThanOrEqual(a);
    });

    it('empty file path in spec falls back to SYSTEM_CLOCKS', () => {
      expect(resolveClockSources('file:')).toBe(SYSTEM_CLOCKS);
    });
  });
});
