import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyBannerDisplayState,
  readBannerDisplayState,
  writeBannerDisplayState,
} from '#/tui/banner/state';
import { getBannerStateFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kimi-banner-state-'));
  process.env['KIMI_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('banner display state cache', () => {
  it('returns an empty state when the file is missing', async () => {
    await expect(readBannerDisplayState()).resolves.toEqual(emptyBannerDisplayState());
  });

  it('falls back to an empty state when the file is corrupt', async () => {
    mkdirSync(join(dir, 'cache', 'banner'), { recursive: true });
    writeFileSync(getBannerStateFile(), '{"broken"', 'utf-8');
    await expect(readBannerDisplayState()).resolves.toEqual(emptyBannerDisplayState());
  });

  it('falls back to an empty state for an unknown future version', async () => {
    mkdirSync(join(dir, 'cache', 'banner'), { recursive: true });
    writeFileSync(
      getBannerStateFile(),
      JSON.stringify({
        version: 2,
        shown: {},
      }),
      'utf-8',
    );
    await expect(readBannerDisplayState()).resolves.toEqual(emptyBannerDisplayState());
  });

  it('writes and reads back the state from cache/banner/state.json', async () => {
    const state = {
      version: 1 as const,
      shown: {
        active: { lastShownAt: '2026-06-16T00:00:00.000Z' },
      },
    };

    await writeBannerDisplayState(state);

    expect(getBannerStateFile()).toBe(join(dir, 'cache', 'banner', 'state.json'));
    await expect(readBannerDisplayState()).resolves.toEqual(state);
  });

  it('drops invalid shown records when reading', async () => {
    mkdirSync(join(dir, 'cache', 'banner'), { recursive: true });
    writeFileSync(
      getBannerStateFile(),
      JSON.stringify({
        version: 1,
        shown: {
          valid: { lastShownAt: '2026-06-16T00:00:00.000Z' },
          invalid: { lastShownAt: 'not-a-date' },
          malformed: { shownAt: '2026-06-16T00:00:00.000Z' },
        },
      }),
      'utf-8',
    );

    await expect(readBannerDisplayState()).resolves.toEqual({
      version: 1,
      shown: {
        valid: { lastShownAt: '2026-06-16T00:00:00.000Z' },
      },
    });
  });
});
