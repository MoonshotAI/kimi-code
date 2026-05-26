import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { SessionSummary, SessionDetail, AgentInfo, SessionHealth } from './agent-record-types';

const SESSION_ID_RE = /^session_[A-Za-z0-9._-]+$/;
const SUPPORTED_PROTOCOL = '1.1';

interface StateJson {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  isCustomTitle?: boolean;
  lastPrompt?: string;
  agents?: Record<string, { homedir: string; type: 'main' | 'sub' | 'independent'; parentAgentId: string | null }>;
  custom?: Record<string, unknown>;
}

export async function listSessions(home: string): Promise<SessionSummary[]> {
  const sessionsDir = join(home, 'sessions');
  const buckets = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const out: SessionSummary[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = join(sessionsDir, bucket.name);
    const sessionDirs = await readdir(bucketDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
      const summary = await tryReadSummary(join(bucketDir, entry.name), entry.name, bucket.name);
      if (summary !== null) out.push(summary);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function readSessionDetail(home: string, sessionId: string): Promise<SessionDetail | null> {
  const sessionDir = await findSessionDir(home, sessionId);
  if (sessionDir === null) return null;
  const state = await readState(sessionDir);
  if (state === null) return null;
  if (state.custom?.['imported_from_kimi_cli'] === true) return null;
  const agents = await inventoryAgents(sessionDir, state);
  return {
    sessionId,
    workDir: '',  // filled by route from index
    state,
    agents,
  };
}

async function tryReadSummary(sessionDir: string, sessionId: string, bucketName: string): Promise<SessionSummary | null> {
  const state = await readState(sessionDir);
  if (state === null) {
    return brokenStateSummary(sessionDir, sessionId, bucketName);
  }
  if (state.custom?.['imported_from_kimi_cli'] === true) return null;

  const mainWirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const mainExists = await pathExists(mainWirePath);
  let mainCount = 0;
  let protocolVersion: string | null = null;
  let health: SessionHealth = 'ok';
  if (!mainExists) {
    health = 'missing_main_wire';
  } else {
    const info = await scanWire(mainWirePath);
    mainCount = info.count;
    protocolVersion = info.protocolVersion;
    if (protocolVersion !== null && protocolVersion !== SUPPORTED_PROTOCOL) {
      health = 'unsupported_protocol';
    }
  }

  return {
    sessionId,
    sessionDir,
    workDir: '', // filled in by caller via session_index lookup
    title: state.title ?? null,
    lastPrompt: state.lastPrompt ?? null,
    isCustomTitle: state.isCustomTitle ?? false,
    createdAt: parseTs(state.createdAt),
    updatedAt: parseTs(state.updatedAt),
    agentCount: Object.keys(state.agents ?? {}).length,
    mainAgentExists: mainExists,
    mainWireRecordCount: mainCount,
    wireProtocolVersion: protocolVersion,
    health,
  };
}

function brokenStateSummary(sessionDir: string, sessionId: string, _bucket: string): SessionSummary {
  return {
    sessionId, sessionDir, workDir: '',
    title: null, lastPrompt: null, isCustomTitle: false,
    createdAt: 0, updatedAt: 0,
    agentCount: 0, mainAgentExists: false, mainWireRecordCount: 0,
    wireProtocolVersion: null, health: 'broken_state',
  };
}

async function inventoryAgents(sessionDir: string, state: StateJson): Promise<AgentInfo[]> {
  const result: AgentInfo[] = [];
  for (const [id, meta] of Object.entries(state.agents ?? {})) {
    const wirePath = join(sessionDir, 'agents', id, 'wire.jsonl');
    const exists = await pathExists(wirePath);
    const info = exists ? await scanWire(wirePath) : { count: 0, protocolVersion: null };
    result.push({
      agentId: id,
      type: meta.type,
      parentAgentId: meta.parentAgentId,
      homedir: meta.homedir,
      wireExists: exists,
      wireRecordCount: info.count,
      wireProtocolVersion: info.protocolVersion,
    });
  }
  return result.sort((a, b) => {
    if (a.agentId === 'main') return -1;
    if (b.agentId === 'main') return 1;
    return a.agentId.localeCompare(b.agentId);
  });
}

async function readState(sessionDir: string): Promise<StateJson | null> {
  try {
    return JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as StateJson;
  } catch { return null; }
}

async function findSessionDir(home: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  // Try index first
  try {
    const indexLines = (await readFile(join(home, 'session_index.jsonl'), 'utf8')).split(/\r?\n/);
    for (const line of indexLines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
      if (entry.sessionId === sessionId && entry.sessionDir && await pathExists(entry.sessionDir)) {
        return entry.sessionDir;
      }
    }
  } catch { /* no index */ }
  // Fall back to scanning buckets
  const buckets = await readdir(join(home, 'sessions'), { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = join(home, 'sessions', bucket.name, sessionId);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function scanWire(path: string): Promise<{ count: number; protocolVersion: string | null }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  let protocolVersion: string | null = null;
  let first = true;
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (first) {
      first = false;
      try {
        const meta = JSON.parse(line) as { type?: string; protocol_version?: string };
        if (meta.type === 'metadata' && typeof meta.protocol_version === 'string') {
          protocolVersion = meta.protocol_version;
        }
      } catch { /* malformed metadata */ }
    }
    count += 1;
  }
  return { count, protocolVersion };
}

function parseTs(input: string | undefined): number {
  if (!input) return 0;
  const n = Date.parse(input);
  return Number.isFinite(n) ? n : 0;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
