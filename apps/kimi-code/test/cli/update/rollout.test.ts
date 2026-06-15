import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRolloutDecisionLog,
  decidePassiveUpdateTarget,
  isRolloutBypassedByExperimentalEnv,
  isRolloutEligible,
  MAX_ROLLOUT_DELAY_SECONDS,
  rolloutBucket,
  rolloutDelayForBucket,
  rolloutDelaySeconds,
  resolveUpdateDeviceId,
  selectPassiveUpdateTarget,
} from '#/cli/update/rollout';
import type { RolloutBatch, UpdateManifest } from '#/cli/update/types';

const STANDARD_ROLLOUT: readonly RolloutBatch[] = [
  { percent: 30, delaySeconds: 0 },
  { percent: 30, delaySeconds: 43_200 },
  { percent: 40, delaySeconds: 86_400 },
];

const PUBLISHED_AT = '2026-06-12T00:00:00.000Z';
const PUBLISHED_AT_MS = Date.parse(PUBLISHED_AT);

function makeManifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: '2.0.0',
    publishedAt: PUBLISHED_AT,
    rollout: STANDARD_ROLLOUT,
    ...overrides,
  };
}

function secondsAfterPublish(seconds: number): Date {
  return new Date(PUBLISHED_AT_MS + seconds * 1000);
}

describe('rolloutBucket', () => {
  it('is deterministic and within 0-99', () => {
    for (let i = 0; i < 200; i++) {
      const bucket = rolloutBucket(`device-${i}`, '2.0.0');
      expect(bucket).toBe(rolloutBucket(`device-${i}`, '2.0.0'));
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      expect(Number.isInteger(bucket)).toBe(true);
    }
  });

  it('matches pinned vectors (regression guard for the hash layout)', () => {
    expect(rolloutBucket('device-a', '1.0.0')).toBe(65);
    expect(rolloutBucket('device-b', '1.0.0')).toBe(76);
    expect(rolloutBucket('fixed-device', '2.0.0')).toBe(26);
  });

  it('reshuffles buckets when the version changes', () => {
    expect(rolloutBucket('device-a', '1.0.1')).toBe(79);
    expect(rolloutBucket('device-a', '1.0.1')).not.toBe(rolloutBucket('device-a', '1.0.0'));
  });
});

describe('rolloutDelayForBucket', () => {
  it('maps buckets to batches at the exact boundaries', () => {
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 0)).toBe(0);
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 29)).toBe(0);
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 30)).toBe(43_200);
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 59)).toBe(43_200);
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 60)).toBe(86_400);
    expect(rolloutDelayForBucket(STANDARD_ROLLOUT, 99)).toBe(86_400);
  });

  it('clamps oversized delays to 24h', () => {
    const rollout: readonly RolloutBatch[] = [{ percent: 100, delaySeconds: 999_999 }];
    expect(rolloutDelayForBucket(rollout, 50)).toBe(MAX_ROLLOUT_DELAY_SECONDS);
  });

  it('assigns buckets not covered by the plan to the slowest cohort', () => {
    const rollout: readonly RolloutBatch[] = [{ percent: 30, delaySeconds: 0 }];
    expect(rolloutDelayForBucket(rollout, 29)).toBe(0);
    expect(rolloutDelayForBucket(rollout, 30)).toBe(MAX_ROLLOUT_DELAY_SECONDS);
    expect(rolloutDelayForBucket(rollout, 99)).toBe(MAX_ROLLOUT_DELAY_SECONDS);
  });

  it('tolerates percents summing past 100', () => {
    const rollout: readonly RolloutBatch[] = [
      { percent: 60, delaySeconds: 0 },
      { percent: 60, delaySeconds: 43_200 },
    ];
    expect(rolloutDelayForBucket(rollout, 59)).toBe(0);
    expect(rolloutDelayForBucket(rollout, 99)).toBe(43_200);
  });

  it('treats an empty plan as fully rolled out', () => {
    expect(rolloutDelayForBucket([], 0)).toBe(0);
    expect(rolloutDelayForBucket([], 99)).toBe(0);
  });
});

describe('rolloutDelaySeconds', () => {
  it('splits 10k devices roughly 30/30/40 across the standard plan', () => {
    const counts = new Map<number, number>([
      [0, 0],
      [43_200, 0],
      [86_400, 0],
    ]);
    const manifest = makeManifest();
    for (let i = 0; i < 10_000; i++) {
      const delay = rolloutDelaySeconds(manifest, `device-${i}`);
      counts.set(delay, (counts.get(delay) ?? 0) + 1);
    }
    expect(counts.get(0)).toBeGreaterThanOrEqual(2_700);
    expect(counts.get(0)).toBeLessThanOrEqual(3_300);
    expect(counts.get(43_200)).toBeGreaterThanOrEqual(2_700);
    expect(counts.get(43_200)).toBeLessThanOrEqual(3_300);
    expect(counts.get(86_400)).toBeGreaterThanOrEqual(3_700);
    expect(counts.get(86_400)).toBeLessThanOrEqual(4_300);
  });
});

describe('isRolloutEligible', () => {
  const delayedForEveryone = makeManifest({
    rollout: [{ percent: 100, delaySeconds: 43_200 }],
  });

  it('is not eligible before publishedAt + delay', () => {
    const justBefore = new Date(PUBLISHED_AT_MS + 43_200 * 1000 - 1);
    expect(isRolloutEligible(delayedForEveryone, 'device-a', justBefore)).toBe(false);
  });

  it('is eligible exactly at publishedAt + delay', () => {
    expect(isRolloutEligible(delayedForEveryone, 'device-a', secondsAfterPublish(43_200))).toBe(
      true,
    );
  });

  it('is not eligible while publishedAt is still in the future', () => {
    const manifest = makeManifest({ rollout: [] });
    expect(isRolloutEligible(manifest, 'device-a', secondsAfterPublish(-3_600))).toBe(false);
  });

  it('is always eligible 24h after publish regardless of the plan', () => {
    const manifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 999_999 }] });
    expect(isRolloutEligible(manifest, 'device-a', secondsAfterPublish(86_400))).toBe(true);
  });

  it('fails open when publishedAt cannot be parsed', () => {
    const manifest = makeManifest({ publishedAt: 'not-a-date' });
    expect(isRolloutEligible(manifest, 'device-a', secondsAfterPublish(-999_999))).toBe(true);
  });
});

describe('selectPassiveUpdateTarget', () => {
  const now = secondsAfterPublish(60);

  it('falls back to plain latest when manifest is null', () => {
    expect(selectPassiveUpdateTarget('1.0.0', '2.0.0', null, 'device-a', now)).toEqual({
      version: '2.0.0',
    });
    expect(selectPassiveUpdateTarget('1.0.0', null, null, 'device-a', now)).toBeNull();
  });

  it('returns null when the manifest version is not newer', () => {
    const manifest = makeManifest({ rollout: [] });
    expect(selectPassiveUpdateTarget('2.0.0', '2.0.0', manifest, 'device-a', now)).toBeNull();
    expect(selectPassiveUpdateTarget('3.0.0', '2.0.0', manifest, 'device-a', now)).toBeNull();
  });

  it('returns the target once the device batch is eligible', () => {
    const manifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 0 }] });
    expect(selectPassiveUpdateTarget('1.0.0', '2.0.0', manifest, 'device-a', now)).toEqual({
      version: '2.0.0',
    });
  });

  it('hides the target while the device batch is not yet eligible', () => {
    const manifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 86_400 }] });
    expect(selectPassiveUpdateTarget('1.0.0', '2.0.0', manifest, 'device-a', now)).toBeNull();
  });
});

describe('decidePassiveUpdateTarget', () => {
  const now = secondsAfterPublish(60);

  it('reports no-latest when nothing is known yet', () => {
    const decision = decidePassiveUpdateTarget('1.0.0', null, null, 'device-a', now);
    expect(decision).toMatchObject({ target: null, reason: 'no-latest' });
  });

  it('reports not-newer when the known version is not an upgrade', () => {
    expect(decidePassiveUpdateTarget('2.0.0', '2.0.0', null, 'device-a', now)).toMatchObject({
      target: null,
      reason: 'not-newer',
    });
    const manifest = makeManifest({ rollout: [] });
    expect(decidePassiveUpdateTarget('2.0.0', '2.0.0', manifest, 'device-a', now)).toMatchObject({
      target: null,
      reason: 'not-newer',
    });
  });

  it('reports no-manifest legacy visibility when only plain latest is known', () => {
    const decision = decidePassiveUpdateTarget('1.0.0', '2.0.0', null, 'device-a', now);
    expect(decision).toMatchObject({
      target: { version: '2.0.0' },
      reason: 'no-manifest',
      bucket: null,
      delaySeconds: null,
      eligibleAt: null,
    });
  });

  it('reports held with bucket, delay and eligibleAt while the batch is gated', () => {
    const manifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 86_400 }] });
    const decision = decidePassiveUpdateTarget(
      '1.0.0',
      '2.0.0',
      manifest,
      'device-a',
      secondsAfterPublish(60),
    );
    expect(decision).toMatchObject({
      target: null,
      reason: 'held',
      bucket: rolloutBucket('device-a', '2.0.0'),
      delaySeconds: 86_400,
      eligibleAt: new Date(PUBLISHED_AT_MS + 86_400 * 1000).toISOString(),
    });
  });

  it('reports eligible once the batch delay has passed', () => {
    const manifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 43_200 }] });
    const decision = decidePassiveUpdateTarget(
      '1.0.0',
      '2.0.0',
      manifest,
      'device-a',
      secondsAfterPublish(43_200),
    );
    expect(decision).toMatchObject({
      target: { version: '2.0.0' },
      reason: 'eligible',
      delaySeconds: 43_200,
    });
  });
});

describe('appendRolloutDecisionLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rollout-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per decision', async () => {
    const file = join(dir, 'updates', 'rollout.log');
    await appendRolloutDecisionLog({ phase: 'startup-cache', reason: 'held' }, file);
    await appendRolloutDecisionLog({ phase: 'prompt-refresh', reason: 'eligible' }, file);

    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ phase: 'startup-cache', reason: 'held' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ phase: 'prompt-refresh', reason: 'eligible' });
  });

  it('resets the file once it grows past the size cap', async () => {
    const file = join(dir, 'rollout.log');
    writeFileSync(file, 'x'.repeat(300 * 1024), 'utf-8');
    await appendRolloutDecisionLog({ reason: 'eligible' }, file);

    const content = readFileSync(file, 'utf-8');
    expect(content.length).toBeLessThan(1024);
    expect(JSON.parse(content.trim())).toMatchObject({ reason: 'eligible' });
  });

  it('never throws on unwritable paths', async () => {
    await expect(
      appendRolloutDecisionLog({ reason: 'held' }, '/dev/null/nope/rollout.log'),
    ).resolves.toBeUndefined();
  });
});

describe('resolveUpdateDeviceId', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rollout-device-id-'));
    process.env['KIMI_CODE_HOME'] = dir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not create the telemetry device id file when one is missing', () => {
    const deviceId = resolveUpdateDeviceId();

    expect(deviceId).toMatch(/^[0-9a-f-]+$/);
    expect(existsSync(join(dir, 'device_id'))).toBe(false);
  });

  it('reuses an existing telemetry device id without rewriting it', () => {
    writeFileSync(join(dir, 'device_id'), 'existing-device-id', 'utf-8');

    expect(resolveUpdateDeviceId()).toBe('existing-device-id');
    expect(readFileSync(join(dir, 'device_id'), 'utf-8')).toBe('existing-device-id');
  });
});

describe('experimental flag bypass', () => {
  const now = secondsAfterPublish(60);
  const heldManifest = makeManifest({ rollout: [{ percent: 100, delaySeconds: 86_400 }] });

  it('bypasses a held rollout and reports experimental', () => {
    const decision = decidePassiveUpdateTarget('1.0.0', '2.0.0', heldManifest, 'device-a', now, true);
    expect(decision).toMatchObject({
      target: { version: '2.0.0' },
      reason: 'experimental',
      bucket: null,
      delaySeconds: null,
      eligibleAt: null,
    });
  });

  it('still reports not-newer / no-latest under bypass', () => {
    expect(decidePassiveUpdateTarget('2.0.0', '2.0.0', heldManifest, 'device-a', now, true)).toMatchObject({
      target: null,
      reason: 'not-newer',
    });
    expect(decidePassiveUpdateTarget('1.0.0', null, null, 'device-a', now, true)).toMatchObject({
      target: null,
      reason: 'no-latest',
    });
  });

  it('marks plain-latest visibility as experimental when bypassing', () => {
    expect(decidePassiveUpdateTarget('1.0.0', '2.0.0', null, 'device-a', now, true)).toMatchObject({
      target: { version: '2.0.0' },
      reason: 'experimental',
    });
  });
});

describe('isRolloutBypassedByExperimentalEnv', () => {
  it('is on for the usual truthy values of KIMI_CODE_EXPERIMENTAL_FLAG', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(isRolloutBypassedByExperimentalEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: value })).toBe(true);
    }
  });

  it('is off when unset, blank, or falsy', () => {
    expect(isRolloutBypassedByExperimentalEnv({})).toBe(false);
    expect(isRolloutBypassedByExperimentalEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: '' })).toBe(false);
    expect(isRolloutBypassedByExperimentalEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: '0' })).toBe(false);
    expect(isRolloutBypassedByExperimentalEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: 'off' })).toBe(false);
  });
});
