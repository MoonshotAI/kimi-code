// apps/vis/server/src/lib/cron-store.ts
//
// Read-only reader for cron tasks, persisted by agent-core under each (non-sub)
// agent's homedir at `<agentDir>/cron/<id>.json` (callers pass the agent
// homedir, `<session>/agents/<id>`). The visualizer never writes these files;
// it mirrors agent-core's on-disk layout (tools/cron/persist.ts) for reading.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CronTask } from './agent-record-types';

/** Cron id format: 8 lowercase hex chars (mirror of agent-core's cron-id
 *  shape). Enforced before joining a path so a stray / hand-edited filename
 *  cannot escape the cron directory. */
const VALID_CRON_ID = /^[0-9a-f]{8}$/;

export function isSafeCronId(id: string): boolean {
  return VALID_CRON_ID.test(id);
}

function cronDirOf(agentDir: string): string {
  return join(agentDir, 'cron');
}

/**
 * Enumerate all persisted cron tasks for a session, sorted by creation time
 * (oldest first, matching how a user scheduled them).
 *
 * Silently skips filenames that don't match `VALID_CRON_ID`, files that fail
 * to read/parse, and records missing the required cron fields.
 */
export async function listCronTasks(agentDir: string): Promise<CronTask[]> {
  const dir = cronDirOf(agentDir);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CronTask[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!VALID_CRON_ID.test(id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (isCronTask(parsed)) out.push(parsed);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

function isCronTask(value: unknown): value is CronTask {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['cron'] === 'string' &&
    typeof o['prompt'] === 'string' &&
    typeof o['createdAt'] === 'number'
  );
}
