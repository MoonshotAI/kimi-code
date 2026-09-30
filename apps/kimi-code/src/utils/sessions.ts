import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeWorkDirKey, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

export interface SessionListEntry {
  readonly id: string;
  readonly title?: string;
  readonly updatedAtMs: number;
}

export async function listSessionsByRecency(
  harness: KimiHarness,
  workDir: string,
): Promise<readonly SessionListEntry[]> {
  const records = await harness.listSessions();
  const root = join(harness.homeDir, 'sessions-v3', sanitizeWorkDirKey(workDir));
  const withMtime = await Promise.all(
    records.map(async (record) => {
      const mtimeMs = await stat(join(root, record.id))
        .then((info) => info.mtimeMs)
        .catch(() => 0);
      return { record, mtimeMs };
    }),
  );
  return withMtime
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => ({ id: entry.record.id, title: entry.record.title, updatedAtMs: entry.mtimeMs }));
}
