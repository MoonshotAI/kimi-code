import { createReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

import {
  isNewerWireVersion,
  migrateV1_4ToV1_5,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '@moonshot-ai/agent-core-v2/wire/migration/migration';

import type { AgentRecord, WireEntry } from './agent-record-types';

export interface WireReadResult {
  metadata: { protocolVersion: string; createdAt: number };
  records: ReadonlyArray<WireEntry>;
  warnings: string[];
}

/** Best-effort fallback for a wire file whose declared `protocol_version` is
 *  below the known migration chain (below 1.0, or otherwise unrecognized-low):
 *  `resolveWireMigrations` threw for it. We retry from the oldest known version
 *  (1.0) and warn the caller; if even that fails we pass records through
 *  unchanged. (Versions at/above the current 1.5 never reach here — they
 *  resolve to an empty chain and are passed through directly.) */
function bestEffortMigrations(): readonly WireMigration[] {
  try {
    return resolveWireMigrations('1.0');
  } catch {
    return [];
  }
}

/** Read a single agent's `wire.jsonl`.
 *
 *  Each record is returned as a `WireEntry` containing both the on-disk parsed
 *  form (`raw`) and the migrated current-protocol form (`data`). The reader
 *  never rejects a file over its `protocol_version`:
 *    - below-1.0 (or otherwise unrecognized-low) — `resolveWireMigrations`
 *      throws, so records run through the 1.0-onwards best-effort chain and a
 *      warning is added to `warnings[]` so the UI can surface the caveat;
 *    - no metadata header — mirrors core-v2's recovery path by treating the
 *      journal as v1.4 and applying the v1.4 → v1.5 migration in memory;
 *    - at/above the current 1.5 (including future versions) — resolves to an
 *      empty chain, so records are passed through unchanged, with no migration
 *      and no warning. */
export async function readAgentWire(path: string): Promise<WireReadResult> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let metadata: WireReadResult['metadata'] | null = null;
  let migrations: readonly WireMigration[] = [];
  let newerWireVersion = false;
  const records: WireEntry[] = [];
  const warnings: string[] = [];
  const agentId = basename(dirname(path));

  for await (const line of rl) {
    lineNo += 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      warnings.push(`line ${lineNo}: invalid JSON (${(error as Error).message})`);
      continue;
    }
    if (!isObject(parsed) || typeof parsed['type'] !== 'string') {
      warnings.push(`line ${lineNo}: missing 'type' field`);
      continue;
    }
    if (metadata === null) {
      if (parsed['type'] === 'metadata') {
        const pv = parsed['protocol_version'];
        const ca = parsed['created_at'];
        if (typeof pv !== 'string' || typeof ca !== 'number') {
          throw new TypeError(`Wire metadata malformed at line ${lineNo}`);
        }
        newerWireVersion = isNewerWireVersion(pv);
        try {
          migrations = resolveWireMigrations(pv);
        } catch (error) {
          warnings.push(
            `unrecognised protocol_version "${pv}" — parsing as best-effort (${(error as Error).message})`,
          );
          migrations = bestEffortMigrations();
        }
        metadata = { protocolVersion: pv, createdAt: ca };
        continue;
      } else {
        warnings.push(
          `line ${lineNo}: missing metadata header — assuming protocol_version "${migrateV1_4ToV1_5.sourceVersion}"`,
        );
        migrations = [migrateV1_4ToV1_5];
        metadata = {
          protocolVersion: migrateV1_4ToV1_5.sourceVersion,
          createdAt: 0,
        };
      }
    }
    const raw = parsed;
    let migrated: Record<string, unknown>;
    try {
      migrated =
        migrations.length === 0
          ? structuredClone(raw)
          : (migrateWireRecord(
              raw as Record<string, unknown> & { type: string },
              migrations,
            ) as Record<string, unknown>);
    } catch (error) {
      // A single record that won't migrate is not fatal — keep the raw
      // payload so the UI can still render whatever fields it understands.
      warnings.push(
        `line ${lineNo}: migration failed (${(error as Error).message}); using raw record`,
      );
      migrated = structuredClone(raw);
    }
    const normalized = newerWireVersion
      ? migrated
      : normalizePlanRevisionRecord(migrated, agentId);
    if (normalized === undefined) {
      warnings.push(`line ${lineNo}: invalid legacy plan.revision record skipped`);
      continue;
    }
    records.push({ lineNo, data: normalized as AgentRecord, raw });
  }
  if (metadata === null) {
    throw new Error('Wire file is empty (no metadata)');
  }
  return { metadata, records, warnings };
}

function normalizePlanRevisionRecord(
  record: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> | undefined {
  if (record['type'] !== 'plan.revision' || 'key' in record) return record;
  const legacyPath = record['path'];
  if (typeof legacyPath !== 'string') return undefined;
  const key = extractLegacyPlanRevisionKey(legacyPath, agentId);
  if (key === undefined) return undefined;
  const { path: _path, ...rest } = record;
  return { ...rest, key };
}

function extractLegacyPlanRevisionKey(path: string, agentId: string): string | undefined {
  if (path.includes('\\')) return undefined;
  const segments = path.split('/');
  if (
    segments.length < 8 ||
    segments[0] !== 'sessions' ||
    segments[3] !== 'agents' ||
    segments[4] !== agentId ||
    segments
      .slice(1, 3)
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  const key = segments.slice(5).join('/');
  return /^plan\/[^/]+\/v[0-9]+\.md$/.test(key) ? key : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
