import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import { readUpdateCache, writeUpdateCache } from '#/cli/update/cache';
import { emptyUpdateCache, type UpdateInstallState } from '#/cli/update/types';
import { getUpdateInstallStateFile, getUpdateStateFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kimi-update-cache-'));
  process.env['KIMI_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update cache', () => {
  it('returns an empty cache when the file is missing', async () => {
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateStateFile(), '{"broken"', 'utf-8');
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache when the file has the old npm.json shape', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        packageName: '@moonshot-ai/kimi-code',
        checkedAt: '2026-04-23T08:00:00.000Z',
        distTags: { beta: '0.0.1-beta.1' },
      }),
      'utf-8',
    );
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('writes and reads back the cache from updates/latest.json', async () => {
    const cache = {
      source: 'cdn',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
      manifest: null,
    } as const;

    await writeUpdateCache(cache);

    expect(getUpdateStateFile()).toBe(join(dir, 'updates', 'latest.json'));
    await expect(readUpdateCache()).resolves.toEqual(cache);
  });

  it('writes and reads back a cache carrying a rollout manifest', async () => {
    const cache = {
      source: 'cdn',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
      manifest: {
        version: '0.5.0',
        publishedAt: '2026-04-23T07:00:00.000Z',
        rollout: [
          { percent: 30, delaySeconds: 0 },
          { percent: 30, delaySeconds: 43_200 },
          { percent: 40, delaySeconds: 86_400 },
        ],
      },
    } as const;

    await writeUpdateCache(cache);

    await expect(readUpdateCache()).resolves.toEqual(cache);
  });

  it('reads a legacy cache file without a manifest field as manifest null', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        source: 'cdn',
        checkedAt: '2026-04-23T08:00:00.000Z',
        latest: '0.5.0',
      }),
      'utf-8',
    );

    await expect(readUpdateCache()).resolves.toEqual({
      source: 'cdn',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
      manifest: null,
    });
  });

  it('keeps latest and treats a malformed manifest field as null', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        source: 'cdn',
        checkedAt: '2026-04-23T08:00:00.000Z',
        latest: '0.5.0',
        manifest: { version: 'not-semver', publishedAt: 'nope', rollout: 'bad' },
      }),
      'utf-8',
    );

    await expect(readUpdateCache()).resolves.toEqual({
      source: 'cdn',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
      manifest: null,
    });
  });
});

describe('update install state', () => {
  it('returns an empty install state when the file is missing', async () => {
    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('falls back to an empty install state when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateInstallStateFile(), '{"broken"', 'utf-8');
    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('writes and reads back the install state from updates/install.json', async () => {
    const state: UpdateInstallState = {
      active: {
        version: '0.5.0',
        source: 'npm-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
      lastFailure: {
        version: '0.4.0',
        failedAt: '2026-04-22T08:00:00.000Z',
        attempts: 1,
      },
      lastSuccess: {
        version: '0.3.0',
        installedAt: '2026-04-21T08:00:00.000Z',
        notifiedAt: null,
      },
    };

    await writeUpdateInstallState(state);

    expect(getUpdateInstallStateFile()).toBe(join(dir, 'updates', 'install.json'));
    await expect(readUpdateInstallState()).resolves.toEqual(state);
  });
});
