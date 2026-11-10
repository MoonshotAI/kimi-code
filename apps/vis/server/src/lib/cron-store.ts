// apps/vis/server/src/lib/cron-store.ts
//
// Read-only reader for cron tasks. v2 persists cron state as durable wire
// records (`cron.add` / `cron.delete` / `cron.cursor`) inside each agent's
// `wire.jsonl` (`packages/agent-core-v2/src/features/cron/`); v1 wrote
// `<agentDir>/cron/<id>.json` files instead. vis reads both: legacy files
// first, then the wire fold on top, so a session written by either engine
// (or carried across both) lists its cron tasks. The visualizer never
// writes anything.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CronTask } from './agent-record-types';
import { readAgentWire } from './wire-reader';

/** Cron id format: 8 lowercase hex chars (legacy v1 ids) or a 26-char ULID
 *  (v2 ids) — mirror of the engine's `CRON_ID_REGEX`
 *  (`features/cron/cronService.ts`). */
const VALID_CRON_ID = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;

export function isSafeCronId(id: string): boolean {
  return VALID_CRON_ID.test(id);
}

function cronDirOf(agentDir: string): string {
  return join(agentDir, 'cron');
}

/**
 * Enumerate all cron tasks for one agent homedir, sorted by creation time
 * (oldest first, matching how a user scheduled them).
 *
 * Legacy `<agentDir>/cron/*.json` files whose names don't match
 * `VALID_CRON_ID`, fail to parse, or miss required fields are skipped;
 * a missing/unreadable `wire.jsonl` contributes no records.
 */
export async function listCronTasks(agentDir: string): Promise<CronTask[]> {
  const byId = new Map<string, CronTask>();
  for (const task of await listCronTaskFiles(agentDir)) {
    byId.set(task.id, task);
  }
  await foldCronWireInto(agentDir, byId);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Legacy v1 layout: one JSON file per task under `<agentDir>/cron/`. */
async function listCronTaskFiles(agentDir: string): Promise<CronTask[]> {
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
  return out;
}

/** v2 layout: fold the agent's wire records — `cron.add` upserts,
 *  `cron.delete` removes, `cron.cursor` advances `lastFiredAt`. The fold
 *  applies on top of the legacy-file state, so the wire (the engine's
 *  authoritative journal) wins for tasks present in both. */
async function foldCronWireInto(agentDir: string, byId: Map<string, CronTask>): Promise<void> {
  let records;
  try {
    ({ records } = await readAgentWire(join(agentDir, 'wire.jsonl')));
  } catch {
    return;
  }
  for (const entry of records) {
    const rec = entry.data;
    switch (rec.type) {
      case 'cron.add':
        if (isCronTask(rec.task)) byId.set(rec.task.id, rec.task);
        break;
      case 'cron.delete': {
        // Tolerate hand-edited / partially corrupted wires: the reader only
        // validates the record's `type`, so guard the payload shape before
        // iterating, the same way `cron.add` goes through `isCronTask`.
        const ids: unknown = rec.ids;
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'string') byId.delete(id);
        }
        break;
      }
      case 'cron.cursor': {
        const id: unknown = rec.id;
        const lastFiredAt: unknown = rec.lastFiredAt;
        if (typeof id !== 'string' || typeof lastFiredAt !== 'number') break;
        const task = byId.get(id);
        if (task !== undefined) byId.set(id, { ...task, lastFiredAt });
        break;
      }
      default:
        break;
    }
  }
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
