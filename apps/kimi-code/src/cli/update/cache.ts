import { z } from 'zod';

import { getUpdateStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

import { UpdateManifestSchema } from './cdn';
import { emptyUpdateCache, type UpdateCache } from './types';

// Stays `.strict()` (we own this file), but a malformed manifest is treated
// as no manifest so one bad optional field does not discard the whole cache.
const UpdateCacheSchema = z
  .object({
    source: z.literal('cdn'),
    checkedAt: z.string().min(1).nullable(),
    latest: z.string().min(1).nullable(),
    manifest: z.preprocess((value) => {
      const parsed = UpdateManifestSchema.nullable().safeParse(value === undefined ? null : value);
      return parsed.success ? parsed.data : null;
    }, z.union([UpdateManifestSchema, z.null()])),
  })
  .strict();

export async function readUpdateCache(
  filePath: string = getUpdateStateFile(),
): Promise<UpdateCache> {
  try {
    return await readJsonFile(filePath, UpdateCacheSchema, emptyUpdateCache());
  } catch {
    return emptyUpdateCache();
  }
}

export async function writeUpdateCache(
  value: UpdateCache,
  filePath: string = getUpdateStateFile(),
): Promise<void> {
  await writeJsonFile(filePath, UpdateCacheSchema, value);
}
