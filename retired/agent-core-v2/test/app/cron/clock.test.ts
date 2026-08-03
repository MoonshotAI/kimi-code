import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveClockSources, SYSTEM_CLOCKS } from '#/app/cron/clock';

describe('cron clock sources', () => {
  describe('SYSTEM_CLOCKS', () => {
    it('returns a non-decreasing monotonic clock', () => {
      let prev = SYSTEM_CLOCKS.monoNowMs();
      for (let i = 0; i < 1000; i++) {
        const next = SYSTEM_CLOCKS.monoNowMs();
        expect(next).toBeGreaterThanOrEqual(prev);
        prev = next;
      }
    });

    it('returns wall time close to Date.now()', () => {
      const before = Date.now();
      const sample = SYSTEM_CLOCKS.wallNow();
      const after = Date.now();
      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('returns a finite positive monotonic value', () => {
      const sample = SYSTEM_CLOCKS.monoNowMs();
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThan(0);
    });
  });

  describe('resolveClockSources default and system specs', () => {
    it('returns SYSTEM_CLOCKS for an undefined spec', () => {
      expect(resolveClockSources(undefined)).toBe(SYSTEM_CLOCKS);
    });

    it('returns SYSTEM_CLOCKS for an empty spec', () => {
      expect(resolveClockSources('')).toBe(SYSTEM_CLOCKS);
    });

    it('returns SYSTEM_CLOCKS for the system spec', () => {
      expect(resolveClockSources('system')).toBe(SYSTEM_CLOCKS);
    });

    it('falls back to SYSTEM_CLOCKS for an unknown scheme', () => {
      expect(resolveClockSources('garbage:foo')).toBe(SYSTEM_CLOCKS);
      expect(resolveClockSources('foobar')).toBe(SYSTEM_CLOCKS);
    });
  });

  describe('resolveClockSources file specs', () => {
    it('reads the file first line on every wallNow call', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');

      writeFileSync(filePath, '1000\n', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);
      expect(clocks.wallNow()).toBe(1000);

      writeFileSync(filePath, '2500', 'utf8');
      expect(clocks.wallNow()).toBe(2500);

      writeFileSync(filePath, '4242\ngarbage\n', 'utf8');
      expect(clocks.wallNow()).toBe(4242);
    });

    it('falls back to Date.now() when the file is missing', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'missing.txt');
      const clocks = resolveClockSources(`file:${filePath}`);

      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();

      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('falls back to Date.now() for unparseable content', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, 'not-a-number\n', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);

      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();

      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('falls back to Date.now() for an empty file', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, '', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);

      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();

      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });

    it('does not use the file source for monoNowMs', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, '1000', 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);

      const a = clocks.monoNowMs();
      const b = clocks.monoNowMs();

      expect(a).not.toBe(1000);
      expect(b).toBeGreaterThanOrEqual(a);
    });

    it('falls back to SYSTEM_CLOCKS for an empty file path', () => {
      expect(resolveClockSources('file:')).toBe(SYSTEM_CLOCKS);
    });

    it('caps file reads at 64 bytes and parses the prefix', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, `${'1234567890\n'}${'x'.repeat(10_000)}`, 'utf8');

      const clocks = resolveClockSources(`file:${filePath}`);

      expect(clocks.wallNow()).toBe(1234567890);
    });

    it('rejects garbage past the 64 byte cap and falls back to Date.now()', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-cron-clock-'));
      const filePath = join(tmpDir, 'now.txt');
      writeFileSync(filePath, 'x'.repeat(100), 'utf8');
      const clocks = resolveClockSources(`file:${filePath}`);

      const before = Date.now();
      const sample = clocks.wallNow();
      const after = Date.now();

      expect(sample).toBeGreaterThanOrEqual(before);
      expect(sample).toBeLessThanOrEqual(after);
    });
  });
});
