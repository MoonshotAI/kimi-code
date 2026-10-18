import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonFileSync } from '#/jsonFile';

export const RATING_COOLDOWN_FILE_NAME = 'feedback-survey-state.json';

export interface RatingCooldownStore {
  read(): Promise<number | undefined>;
  write(lastShownTime: number): Promise<void>;
}

const ratingCooldownStateSchema = z.object({
  version: z.literal(1),
  last_shown_time: z.number(),
});

export function ratingCooldownFile(dataDir: string): RatingCooldownStore {
  const filePath = join(dataDir, RATING_COOLDOWN_FILE_NAME);
  return {
    read: async () => {
      try {
        const state = ratingCooldownStateSchema.safeParse(
          JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
        );
        return state.success && Number.isFinite(state.data.last_shown_time)
          ? state.data.last_shown_time
          : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (lastShownTime) => {
      writeJsonFileSync(filePath, ratingCooldownStateSchema, {
        version: 1,
        last_shown_time: lastShownTime,
      });
    },
  };
}
