import { z } from 'zod';

import { getRecommendedEffortStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFileSync } from '#/utils/persistence';

const RecommendedEffortStateSchema = z.record(
  z.string(),
  z.object({
    version: z.number().int().min(0),
    applied_at: z.string(),
  }),
);

export type RecommendedEffortState = z.infer<typeof RecommendedEffortStateSchema>;

export async function readRecommendedEffortState(
  filePath: string = getRecommendedEffortStateFile(),
): Promise<RecommendedEffortState> {
  try {
    return await readJsonFile(filePath, RecommendedEffortStateSchema, {});
  } catch {
    return {};
  }
}

export function writeRecommendedEffortState(
  state: RecommendedEffortState,
  filePath: string = getRecommendedEffortStateFile(),
): void {
  writeJsonFileSync(filePath, RecommendedEffortStateSchema, state);
}
