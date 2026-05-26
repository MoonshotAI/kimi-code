import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { AgentRecord } from './agent-record-types';

// Hardcoded to keep vitest from pulling agent-core's full runtime (which
// imports a .yaml asset) when this module is loaded in test environments.
// Kept in sync with agent-core's AGENT_WIRE_PROTOCOL_VERSION constant.
const AGENT_WIRE_PROTOCOL_VERSION = '1.1';

export interface WireReadResult {
  metadata: { protocolVersion: string; createdAt: number };
  records: ReadonlyArray<AgentRecord & { _lineNo: number }>;
  warnings: string[];
}

export async function readAgentWire(path: string): Promise<WireReadResult> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let metadata: WireReadResult['metadata'] | null = null;
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
      if (pv !== AGENT_WIRE_PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported protocol version "${pv}" (vis supports ${AGENT_WIRE_PROTOCOL_VERSION})`,
        );
      }
      metadata = { protocolVersion: pv, createdAt: ca };
      continue;
    }
    records.push({ ...(parsed as AgentRecord), _lineNo: lineNo });
  }
  if (metadata === null) {
    throw new Error('Wire file is empty (no metadata)');
  }
  return { metadata, records, warnings };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
