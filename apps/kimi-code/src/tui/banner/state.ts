import { z } from 'zod';

import { getBannerStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

export type BannerDisplayRecord = {
  lastShownAt: string;
};

export type BannerDisplayState = {
  version: 1;
  shown: Record<string, BannerDisplayRecord>;
};

const BannerDisplayRecordSchema = z
  .object({
    lastShownAt: z.string().min(1),
  })
  .strict();

const BannerDisplayStateSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) return value;
    const shown = (value as { shown?: unknown }).shown;
    if (typeof shown !== 'object' || shown === null) {
      return { ...(value as Record<string, unknown>), shown: {} };
    }

    const normalizedShown: Record<string, BannerDisplayRecord> = {};
    for (const [key, record] of Object.entries(shown)) {
      if (key.length === 0 || typeof record !== 'object' || record === null) continue;
      const lastShownAt = (record as { lastShownAt?: unknown }).lastShownAt;
      if (typeof lastShownAt !== 'string' || Number.isNaN(Date.parse(lastShownAt))) continue;
      normalizedShown[key] = { lastShownAt };
    }

    return { ...(value as Record<string, unknown>), shown: normalizedShown };
  },
  z
    .object({
      version: z.literal(1),
      shown: z.record(z.string().min(1), BannerDisplayRecordSchema),
    })
    .strict(),
);

export function emptyBannerDisplayState(): BannerDisplayState {
  return {
    version: 1,
    shown: {},
  };
}

export async function readBannerDisplayState(
  filePath: string = getBannerStateFile(),
): Promise<BannerDisplayState> {
  try {
    return await readJsonFile(filePath, BannerDisplayStateSchema, emptyBannerDisplayState());
  } catch {
    return emptyBannerDisplayState();
  }
}

export async function writeBannerDisplayState(
  value: BannerDisplayState,
  filePath: string = getBannerStateFile(),
): Promise<void> {
  await writeJsonFile(filePath, BannerDisplayStateSchema, value);
}
