import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '@moonshot-ai/agent-core/agent/records/migration';

import type { AgentRecord, WireEntry } from './agent-record-types';

export interface WireReadResult {
  metadata: { protocolVersion: string; createdAt: number };
  records: ReadonlyArray<WireEntry>;
  warnings: string[];
}

/** Best-effort fallback when a wire file declares a protocol_version that
 *  `agent-core` does not know about (e.g. the historic "2.2" alias that
 *  pre-dates the 1.x renumber). We try to apply the chain *starting* from
 *  the oldest known version (1.0) and warn the caller. If even that fails
 *  we just pass records through unchanged. */
function bestEffortMigrations(): readonly WireMigration[] {
  try {
    return resolveWireMigrations('1.0');
  } catch {
    return [];
  }
}

/** Read a single agent's `wire.jsonl`.
 *
 *  Each record is returned as a `WireEntry` containing both the
 *  on-disk parsed form (`raw`) and the migrated current-protocol form
 *  (`data`). For wires that declare a protocol version `agent-core`
 *  does not recognise (historic 2.x labels, or truly future versions),
 *  the reader falls back to a best-effort path: records are run
 *  through the 1.0-onwards migration chain and a warning is added to
 *  `warnings[]` so the UI can surface the caveat. */
export async function readAgentWire(path: string): Promise<WireReadResult> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let metadata: WireReadResult['metadata'] | null = null;
  let migrations: readonly WireMigration[] = [];
  const records: WireEntry[] = [];
  const warnings: string[] = [];

  for await (const line of rl) {
    lineNo += 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warnings.push(`line ${lineNo}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    if (!isObject(parsed) || typeof parsed.type !== 'string') {
      warnings.push(`line ${lineNo}: missing 'type' field`);
      continue;
    }
    if (metadata === null) {
      if (parsed.type !== 'metadata') {
        throw new Error(`Wire file missing metadata header at line ${lineNo}`);
      }
      const pv = parsed['protocol_version'];
      const ca = parsed['created_at'];
      if (typeof pv !== 'string' || typeof ca !== 'number') {
        throw new Error(`Wire metadata malformed at line ${lineNo}`);
      }
      try {
        migrations = resolveWireMigrations(pv);
      } catch (err) {
        warnings.push(
          `unrecognised protocol_version "${pv}" — parsing as best-effort (${(err as Error).message})`,
        );
        migrations = bestEffortMigrations();
      }
      metadata = { protocolVersion: pv, createdAt: ca };
      continue;
    }
    const raw = parsed as Record<string, unknown>;
    let migrated: Record<string, unknown>;
    try {
      migrated =
        migrations.length === 0
          ? raw
          : (migrateWireRecord(
              raw as Record<string, unknown> & { type: string },
              migrations,
            ) as Record<string, unknown>);
    } catch (err) {
      // A single record that won't migrate is not fatal — keep the raw
      // payload so the UI can still render whatever fields it understands.
      warnings.push(
        `line ${lineNo}: migration failed (${(err as Error).message}); using raw record`,
      );
      migrated = raw;
    }
    records.push({ lineNo, data: migrated as AgentRecord, raw });
  }
  if (metadata === null) {
    throw new Error('Wire file is empty (no metadata)');
  }
  return { metadata, records, warnings };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
