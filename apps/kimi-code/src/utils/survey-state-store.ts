import { z } from 'zod';

import { getSurveyStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFileSync } from '#/utils/persistence';

const SurveyStateSchema = z.object({
  version: z.literal(1),
  last_shown_time: z.number(),
});

export async function readSurveyLastShownTime(
  filePath: string = getSurveyStateFile(),
): Promise<number | undefined> {
  try {
    const state = await readJsonFile(filePath, SurveyStateSchema, {
      version: 1,
      last_shown_time: Number.NaN,
    });
    return Number.isFinite(state.last_shown_time) ? state.last_shown_time : undefined;
  } catch {
    return undefined;
  }
}

export function writeSurveyLastShownTime(
  lastShownTime: number,
  filePath: string = getSurveyStateFile(),
): void {
  writeJsonFileSync(filePath, SurveyStateSchema, {
    version: 1,
    last_shown_time: lastShownTime,
  });
}
