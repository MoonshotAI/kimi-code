import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '@moonshot-ai/agent-core/agent/records/migration';

import type { AgentRecord } from './agent-record-types';

export interface WireReadResult {
  metadata: { protocolVersion: string; createdAt: number };
  records: ReadonlyArray<AgentRecord & { _lineNo: number }>;
  warnings: string[];
}

/** Read a single agent's `wire.jsonl`.
 *
 *  Each record is migrated to the current `AgentRecord` shape using
 *  `agent-core`'s migration chain, so older-but-supported wire files
 *  (e.g. protocol 1.0) are transparently upgraded on read. The metadata
 *  header retains the on-disk version so the UI can surface it. */
export async function readAgentWire(path: string): Promise<WireReadResult> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let metadata: WireReadResult['metadata'] | null = null;
  let migrations: readonly WireMigration[] = [];
  const records: (AgentRecord & { _lineNo: number })[] = [];
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
        // Wrap so the route's error classifier still recognises this case
        // via the "unsupported protocol" substring.
        throw new Error(
          `Unsupported protocol version "${pv}": ${(err as Error).message}`,
        );
      }
      metadata = { protocolVersion: pv, createdAt: ca };
      continue;
    }
    const migrated =
      migrations.length === 0
        ? (parsed as Record<string, unknown>)
        : (migrateWireRecord(parsed as Record<string, unknown> & { type: string }, migrations) as Record<string, unknown>);
    records.push({ ...(migrated as AgentRecord), _lineNo: lineNo });
  }
  if (metadata === null) {
    throw new Error('Wire file is empty (no metadata)');
  }
  return { metadata, records, warnings };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
