/**
 * One-shot config migrations — mirror of agent-core's `config/migrations.ts`
 * (the two engines share neither code nor config abstractions, only the
 * on-disk `config.toml` and the `<home>/migrations-effort.json` marker
 * format). Each migration runs at most once per kimi home: a marker records
 * completion (ISO timestamp), so a value the user re-sets by hand afterwards
 * is never migrated again. Best-effort and never throws — a migration must
 * never block startup.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';

import { type IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { isPlainObject } from './configPure';

const MIGRATIONS_FILE = 'migrations-effort.json';
const THINKING_EFFORT_MAX_TO_HIGH = 'thinking-effort-max-to-high';
const CONFIG_SCOPE = '';

function readMigrationMarkers(homeDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homeDir, MIGRATIONS_FILE), 'utf-8'));
    if (isPlainObject(parsed)) return parsed as Record<string, string>;
  } catch {
    // Missing or corrupt marker file — treated as "no migrations done".
  }
  return {};
}

function writeMigrationMarker(homeDir: string, key: string): void {
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const markers = readMigrationMarkers(homeDir);
    markers[key] = new Date().toISOString();
    writeFileSync(join(homeDir, MIGRATIONS_FILE), `${JSON.stringify(markers, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // A lost marker only means the check runs once more — harmless.
  }
}

/**
 * Persisted `thinking.effort = "max"` dates from when the UI recorded any pick
 * unconditionally. `max` is session-only now, so rewrite it to `"high"` once.
 * Skipped when the marker exists; a config document that cannot be read is
 * left untouched AND unmarked so the next start retries. All other values —
 * and a `max` the user writes by hand after the migration — are honored as-is.
 */
export async function migrateThinkingEffortMaxToHigh(
  documentStore: IAtomicDocumentStore,
  configKey: string,
  homeDir: string,
): Promise<void> {
  try {
    if (readMigrationMarkers(homeDir)[THINKING_EFFORT_MAX_TO_HIGH] !== undefined) return;
    let doc: Record<string, unknown> | undefined;
    try {
      const data = await documentStore.get<Record<string, unknown>>(CONFIG_SCOPE, configKey);
      doc = data !== undefined && isPlainObject(data) ? data : {};
    } catch {
      return; // Unreadable config: no marker, retry on the next start.
    }
    const thinking = doc['thinking'];
    if (isPlainObject(thinking) && thinking['effort'] === 'max') {
      doc['thinking'] = { ...thinking, effort: 'high' };
      await documentStore.set(CONFIG_SCOPE, configKey, doc);
    }
    writeMigrationMarker(homeDir, THINKING_EFFORT_MAX_TO_HIGH);
  } catch {
    // Best-effort: never block startup on a migration.
  }
}
