import { z } from 'zod';

import { getModelMigrationStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

/**
 * Records, per source model alias, the target model id a migration prompt was
 * already answered for. The prompt returns only when the registry declares a
 * different target.
 */
const ModelMigrationStateSchema = z.object({
  version: z.literal(1),
  acknowledged: z.record(z.string().min(1), z.string().min(1)),
});

export async function readModelMigrationAcknowledgements(
  filePath: string = getModelMigrationStateFile(),
): Promise<Record<string, string>> {
  try {
    const state = await readJsonFile(filePath, ModelMigrationStateSchema, {
      version: 1,
      acknowledged: {},
    });
    return state.acknowledged;
  } catch {
    return {};
  }
}

export async function acknowledgeModelMigration(
  fromAlias: string,
  toModel: string,
  filePath: string = getModelMigrationStateFile(),
): Promise<void> {
  const acknowledged = await readModelMigrationAcknowledgements(filePath);
  await writeJsonFile(filePath, ModelMigrationStateSchema, {
    version: 1,
    acknowledged: { ...acknowledged, [fromAlias]: toModel },
  });
}
