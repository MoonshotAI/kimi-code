import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readRecommendedEffortState,
  writeRecommendedEffortState,
} from '#/utils/recommended-effort-state-store';

describe('recommended-effort-state-store', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-recommended-effort-state-'));
    file = join(dir, 'recommended-effort-state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty record when the file is missing', async () => {
    await expect(readRecommendedEffortState(file)).resolves.toEqual({});
  });

  it('round-trips per-model applied markers', async () => {
    const state = {
      k3: { version: 1757001600, applied_at: '2026-09-05T02:00:00.000Z' },
      'k3-256k': { version: 2, applied_at: '2026-09-06T02:00:00.000Z' },
    };
    writeRecommendedEffortState(state, file);
    await expect(readRecommendedEffortState(file)).resolves.toEqual(state);
  });

  it('returns an empty record when the file is corrupt', async () => {
    await writeFile(file, 'not json', 'utf-8');
    await expect(readRecommendedEffortState(file)).resolves.toEqual({});
  });

  it('returns an empty record when the schema does not match', async () => {
    await writeFile(file, JSON.stringify({ k3: { version: 'new' } }), 'utf-8');
    await expect(readRecommendedEffortState(file)).resolves.toEqual({});
  });

  it('merges a new model marker into the existing state', async () => {
    writeRecommendedEffortState(
      { k3: { version: 1, applied_at: '2026-09-05T02:00:00.000Z' } },
      file,
    );
    const state = await readRecommendedEffortState(file);
    writeRecommendedEffortState(
      {
        ...state,
        'k3-256k': { version: 3, applied_at: '2026-09-06T02:00:00.000Z' },
      },
      file,
    );
    await expect(readRecommendedEffortState(file)).resolves.toEqual({
      k3: { version: 1, applied_at: '2026-09-05T02:00:00.000Z' },
      'k3-256k': { version: 3, applied_at: '2026-09-06T02:00:00.000Z' },
    });
  });
});
