import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import type { SessionSummary, SessionDetail, AgentInfo, SessionHealth } from './agent-record-types';

const SESSION_ID_RE = /^session_[A-Za-z0-9._-]+$/;
const AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Reject agent ids that could escape the session directory via path
 *  joins. Defence-in-depth: the on-disk source of these ids is
 *  agent-core (which only generates main / agent-N), but a corrupted
 *  or hand-edited `state.json.agents` key could otherwise turn vis
 *  into a local-file-read primitive when exposed beyond loopback. */
export function isSafeAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id) && id !== '.' && id !== '..';
}

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
  const index = await readSessionIndex(home);
  const out: SessionSummary[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = join(sessionsDir, bucket.name);
    const sessionDirs = await readdir(bucketDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
      const sessionDir = join(bucketDir, entry.name);
      const workDir = index.get(entry.name)?.workDir ?? '';
      const summary = await tryReadSummary(sessionDir, entry.name, workDir);
      if (summary !== null) out.push(summary);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function readSessionDetail(home: string, sessionId: string): Promise<SessionDetail | null> {
  const sessionDir = await findSessionDir(home, sessionId);
  if (sessionDir === null) return null;
  const index = await readSessionIndex(home);
  const workDir = index.get(sessionId)?.workDir ?? '';
  const state = await readState(sessionDir);
  // When state.json is unreadable we still return a SessionDetail so the
  // UI can render the broken-state diagnostic. Agent inventory cannot be
  // derived from state, but the on-disk `agents/<id>/wire.jsonl` files
  // are independent of state — probe for them directly so users can
  // still inspect the wire/context of a session whose state is corrupt.
  if (state === null) {
    const agents = await discoverAgentsFromDisk(sessionDir);
    return { sessionId, sessionDir, workDir, state: null, agents };
  }
  if (state.custom?.['imported_from_kimi_cli'] === true) return null;
  const agents = await inventoryAgents(sessionDir, state);
  return { sessionId, sessionDir, workDir, state, agents };
}

/** Fallback inventory used when `state.json` is unreadable: walk
 *  `<sessionDir>/agents/*` directly and synthesize minimal AgentInfo
 *  records for the directories that contain a `wire.jsonl`. Parent
 *  links and `type` are unknown without state, so we mark every agent
 *  as `independent` with a null parent — the routes only need
 *  `agentId` + `wireExists` to serve wire/context. */
async function discoverAgentsFromDisk(sessionDir: string): Promise<AgentInfo[]> {
  const agentsDir = join(sessionDir, 'agents');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!isSafeAgentId(id)) continue;
    const wirePath = join(agentsDir, id, 'wire.jsonl');
    const exists = await pathExists(wirePath);
    let readable = exists;
    let info: { count: number; protocolVersion: string | null } = { count: 0, protocolVersion: null };
    if (exists) {
      try {
        info = await scanWire(wirePath);
      } catch {
        readable = false;
      }
    }
    out.push({
      agentId: id,
      type: id === 'main' ? 'main' : 'independent',
      parentAgentId: null,
      homedir: join(agentsDir, id),
      wireExists: readable,
      wireRecordCount: info.count,
      wireProtocolVersion: info.protocolVersion,
    });
  }
  return out.sort((a, b) => {
    if (a.agentId === 'main') return -1;
    if (b.agentId === 'main') return 1;
    return a.agentId.localeCompare(b.agentId);
  });
}

async function tryReadSummary(sessionDir: string, sessionId: string, workDir: string): Promise<SessionSummary | null> {
  const state = await readState(sessionDir);
  if (state === null) {
    return brokenStateSummary(sessionDir, sessionId, workDir);
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
    try {
      const info = await scanWire(mainWirePath);
      mainCount = info.count;
      protocolVersion = info.protocolVersion;
      // Note: the protocol version is not used to gate health any more —
      // the wire-reader best-efforts unknown versions with a warning.
    } catch {
      // A single unreadable wire file must not fail the whole list.
      health = 'broken_main_wire';
    }
  }

  return {
    sessionId,
    sessionDir,
    workDir,
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

function brokenStateSummary(sessionDir: string, sessionId: string, workDir: string): SessionSummary {
  return {
    sessionId, sessionDir, workDir,
    title: null, lastPrompt: null, isCustomTitle: false,
    createdAt: 0, updatedAt: 0,
    agentCount: 0, mainAgentExists: false, mainWireRecordCount: 0,
    wireProtocolVersion: null, health: 'broken_state',
  };
}

interface SessionIndexEntry {
  sessionDir: string;
  workDir: string;
}

async function readSessionIndex(home: string): Promise<Map<string, SessionIndexEntry>> {
  const out = new Map<string, SessionIndexEntry>();
  let raw: string;
  try {
    raw = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { sessionId?: string; sessionDir?: string; workDir?: string };
      if (typeof entry.sessionId === 'string' && typeof entry.sessionDir === 'string') {
        out.set(entry.sessionId, {
          sessionDir: entry.sessionDir,
          workDir: typeof entry.workDir === 'string' ? entry.workDir : '',
        });
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

async function inventoryAgents(sessionDir: string, state: StateJson): Promise<AgentInfo[]> {
  const result: AgentInfo[] = [];
  for (const [id, meta] of Object.entries(state.agents ?? {})) {
    if (!isSafeAgentId(id)) continue;
    const wirePath = join(sessionDir, 'agents', id, 'wire.jsonl');
    const exists = await pathExists(wirePath);
    let readable = exists;
    let info: { count: number; protocolVersion: string | null } = { count: 0, protocolVersion: null };
    if (exists) {
      try {
        info = await scanWire(wirePath);
      } catch {
        // The file exists but is unreadable / malformed. Report it as
        // unavailable so wire/context routes return 404 ("wire missing")
        // instead of 500 ("READ_ERROR") and the UI shows the "no wire"
        // badge consistently with the missing-file path.
        readable = false;
      }
    }
    result.push({
      agentId: id,
      type: meta.type,
      parentAgentId: meta.parentAgentId,
      homedir: meta.homedir,
      wireExists: readable,
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
  const sessionsRoot = resolve(join(home, 'sessions'));
  const sessionsRootPrefix = sessionsRoot + sep;
  // Try index first — but only trust entries that point *under*
  // `<home>/sessions/` AND whose basename matches the requested id.
  // This blocks stale/poisoned index lines from redirecting reads to
  // unrelated directories.
  try {
    const indexLines = (await readFile(join(home, 'session_index.jsonl'), 'utf8')).split(/\r?\n/);
    for (const line of indexLines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
      if (entry.sessionId !== sessionId || typeof entry.sessionDir !== 'string') continue;
      const candidate = resolve(entry.sessionDir);
      if (!candidate.startsWith(sessionsRootPrefix)) continue;
      if (candidate.split(sep).pop() !== sessionId) continue;
      if (await pathExists(candidate)) return candidate;
    }
  } catch { /* no index */ }
  // Fall back to scanning buckets
  const buckets = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = join(sessionsRoot, bucket.name, sessionId);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function scanWire(path: string): Promise<{ count: number; protocolVersion: string }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  let protocolVersion: string | null = null;
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (protocolVersion === null) {
      // Strict: the first non-empty line MUST be a well-formed
      // `metadata` record. Otherwise the list-view health would say
      // "ok" while the wire-reader rejects the file on open.
      let parsed: { type?: unknown; protocol_version?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        throw new Error(`wire metadata is not valid JSON at line 1`);
      }
      if (parsed.type !== 'metadata' || typeof parsed.protocol_version !== 'string') {
        throw new Error(`wire is missing a metadata header on line 1`);
      }
      protocolVersion = parsed.protocol_version;
    }
    count += 1;
  }
  if (protocolVersion === null) {
    throw new Error('wire file is empty');
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
