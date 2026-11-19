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
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import { fromPersistentWireRecord } from '@moonshot-ai/agent-core-v2/wire/wireService';

import type { AgentRecord, WireEntry } from './agent-record-types';

export interface WireReadResult {
  metadata: { protocolVersion: string; createdAt: number };
  records: ReadonlyArray<WireEntry>;
  warnings: string[];
}

function bestEffortMigrations(): readonly WireMigration[] {
  try {
    return resolveWireMigrations('1.0');
  } catch {
    return [];
  }
}

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
    records.push({
      lineNo,
      data: fromPersistentWireRecord(normalized as WireRecord) as AgentRecord,
      raw,
    });
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
