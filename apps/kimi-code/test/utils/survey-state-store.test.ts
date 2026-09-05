import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSurveyLastShownTime,
  writeSurveyLastShownTime,
} from '#/utils/survey-state-store';

describe('survey-state-store', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-survey-state-'));
    file = join(dir, 'feedback-survey-state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when the file is missing', async () => {
    await expect(readSurveyLastShownTime(file)).resolves.toBeUndefined();
  });

  it('round-trips last_shown_time', async () => {
    writeSurveyLastShownTime(1_700_000_000_000, file);
    await expect(readSurveyLastShownTime(file)).resolves.toBe(1_700_000_000_000);
  });

  it('returns undefined when the file is corrupt', async () => {
    await writeFile(file, 'not json', 'utf-8');
    await expect(readSurveyLastShownTime(file)).resolves.toBeUndefined();
  });

  it('returns undefined when the schema does not match', async () => {
    await writeFile(file, JSON.stringify({ version: 2, last_shown_time: 1 }), 'utf-8');
    await expect(readSurveyLastShownTime(file)).resolves.toBeUndefined();
  });

  it('overwrites a previous timestamp atomically', async () => {
    writeSurveyLastShownTime(1, file);
    writeSurveyLastShownTime(2, file);
    await expect(readSurveyLastShownTime(file)).resolves.toBe(2);
  });
});
