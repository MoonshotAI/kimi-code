import { z } from 'zod';

import { getUpdateInstallStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

import { emptyUpdateInstallState, type InstallSource, type UpdateInstallState } from './types';

const InstallSourceSchema: z.ZodType<InstallSource> = z.enum([
  'npm-global',
  'pnpm-global',
  'yarn-global',
  'bun-global',
  'homebrew',
  'native',
  'unsupported',
]);

const UpdateInstallStateSchema: z.ZodType<UpdateInstallState> = z
  .object({
    active: z
      .object({
        version: z.string().min(1),
        source: InstallSourceSchema,
        startedAt: z.string().min(1),
      })
      .strict()
      .nullable(),
    lastFailure: z
      .object({
        version: z.string().min(1),
        failedAt: z.string().min(1),
        attempts: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    lastSuccess: z
      .object({
        version: z.string().min(1),
        installedAt: z.string().min(1),
        notifiedAt: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export { emptyUpdateInstallState };

export async function readUpdateInstallState(
  filePath: string = getUpdateInstallStateFile(),
): Promise<UpdateInstallState> {
  try {
    return await readJsonFile(filePath, UpdateInstallStateSchema, emptyUpdateInstallState());
  } catch {
    return emptyUpdateInstallState();
  }
}

export async function writeUpdateInstallState(
  value: UpdateInstallState,
  filePath: string = getUpdateInstallStateFile(),
): Promise<void> {
  await writeJsonFile(filePath, UpdateInstallStateSchema, value);
}
