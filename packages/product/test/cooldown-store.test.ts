import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RATING_COOLDOWN_FILE_NAME,
  ratingCooldownFile,
  type RatingCooldownStore,
} from '#/session-rating/node/cooldown-store';

describe('ratingCooldownFile', () => {
  let dir: string;
  let file: string;
  let store: RatingCooldownStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-survey-state-'));
    file = join(dir, RATING_COOLDOWN_FILE_NAME);
    store = ratingCooldownFile(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the file name shared with earlier CLI releases', () => {
    expect(RATING_COOLDOWN_FILE_NAME).toBe('feedback-survey-state.json');
  });

  it('returns undefined when the file is missing', () => {
    expect(store.read()).toBeUndefined();
  });

  it('round-trips last_shown_time', () => {
    store.write(1_700_000_000_000);
    expect(store.read()).toBe(1_700_000_000_000);
  });

  it('returns undefined when the file is corrupt', async () => {
    await writeFile(file, 'not json', 'utf-8');
    expect(store.read()).toBeUndefined();
  });

  it('returns undefined when the schema does not match', async () => {
    await writeFile(file, JSON.stringify({ version: 2, last_shown_time: 1 }), 'utf-8');
    expect(store.read()).toBeUndefined();
  });

  it('overwrites a previous timestamp atomically', () => {
    store.write(1);
    store.write(2);
    expect(store.read()).toBe(2);
  });

  it('reads the format earlier CLI releases wrote', async () => {
    await writeFile(
      file,
      `${JSON.stringify({ version: 1, last_shown_time: 1_700_000_000_000 }, null, 2)}\n`,
      'utf-8',
    );
    expect(store.read()).toBe(1_700_000_000_000);
  });
});
