import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import type { SessionSummary, SessionDetail, AgentInfo, SessionHealth, ImportInfo } from './agent-record-types';
import { compareAgentIds } from './agent-tree';
import { importedDirOf, isImportId, listImportedIds, readImportMeta } from './import-store';

const SESSION_ID_RE = /^session_[A-Za-z0-9._-]+$/;
const AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id) && id !== '.' && id !== '..';
}

interface StateJson {
  createdAt?: string | number;
  updatedAt?: string | number;
  cwd?: string;
  workDir?: string;
  title?: string;
  isCustomTitle?: boolean;
  lastPrompt?: string;
  agents?: Record<string, unknown>;
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
  for (const importId of await listImportedIds(home)) {
    const dir = importedDirOf(home, importId);
    const meta = await readImportMeta(home, importId);
    const workDir = meta?.manifest?.workspaceDir ?? '';
    const summary = await tryReadSummary(dir, importId, workDir, { imported: true, importMeta: meta });
    if (summary !== null) out.push(summary);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function readSessionDetail(home: string, sessionId: string): Promise<SessionDetail | null> {
  if (isImportId(sessionId)) return readImportedDetail(home, sessionId);
  const sessionDir = await findSessionDir(home, sessionId);
  if (sessionDir === null) return null;
  const index = await readSessionIndex(home);
  const workDir = index.get(sessionId)?.workDir ?? '';
  const state = await readState(sessionDir);
  if (state === null) {
    const agents = await discoverAgentsFromDisk(sessionDir);
    return { sessionId, sessionDir, workDir, state: null, agents, imported: false, importMeta: null };
  }
  if (state.custom?.['imported_from_kimi_cli'] === true) return null;
  const agents = await inventoryAgents(sessionDir, state);
  return {
    sessionId,
    sessionDir,
    workDir: recoverWorkDir(state, workDir),
    state,
    agents,
    imported: false,
    importMeta: null,
  };
}

async function readImportedDetail(home: string, importId: string): Promise<SessionDetail | null> {
  const sessionDir = importedDirOf(home, importId);
  if (!(await pathExists(sessionDir))) return null;
  const meta = await readImportMeta(home, importId);
  const workDir = meta?.manifest?.workspaceDir ?? '';
  const state = await readState(sessionDir);
  if (state === null) {
    const agents = await discoverAgentsFromDisk(sessionDir);
    return { sessionId: importId, sessionDir, workDir, state: null, agents, imported: true, importMeta: meta };
  }
  let agents = await inventoryAgents(sessionDir, state);
  if (agents.length === 0) {
    agents = await discoverAgentsFromDisk(sessionDir);
  }
  return {
    sessionId: importId,
    sessionDir,
    workDir: recoverWorkDir(state, workDir),
    state,
    agents,
    imported: true,
    importMeta: meta,
  };
}

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
      profileName: null,
      homedir: join(agentsDir, id),
      wireExists: readable,
      wireRecordCount: info.count,
      wireProtocolVersion: info.protocolVersion,
      swarmItem: null,
    });
  }
  return out.sort((a, b) => compareAgentIds(a.agentId, b.agentId));
}

async function tryReadSummary(
  sessionDir: string,
  sessionId: string,
  workDir: string,
  opts: { imported?: boolean; importMeta?: ImportInfo | null } = {},
): Promise<SessionSummary | null> {
  const imported = opts.imported ?? false;
  const importMeta = opts.importMeta ?? null;
  const state = await readState(sessionDir);
  if (state === null) {
    return brokenStateSummary(sessionDir, sessionId, workDir, imported, importMeta);
  }
  if (!imported && state.custom?.['imported_from_kimi_cli'] === true) return null;

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
    } catch {
      health = 'broken_main_wire';
    }
  }

  return {
    sessionId,
    sessionDir,
    workDir: recoverWorkDir(state, workDir),
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
    imported,
    importMeta,
  };
}

function brokenStateSummary(
  sessionDir: string,
  sessionId: string,
  workDir: string,
  imported = false,
  importMeta: ImportInfo | null = null,
): SessionSummary {
  return {
    sessionId, sessionDir, workDir,
    title: null, lastPrompt: null, isCustomTitle: false,
    createdAt: 0, updatedAt: 0,
    agentCount: 0, mainAgentExists: false, mainWireRecordCount: 0,
    wireProtocolVersion: null, health: 'broken_state',
    imported, importMeta,
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
    } catch {}
  }
  return out;
}

async function inventoryAgents(sessionDir: string, state: StateJson): Promise<AgentInfo[]> {
  const result: AgentInfo[] = [];
  for (const [id, meta] of Object.entries(state.agents ?? {})) {
    if (!isSafeAgentId(id)) continue;
    if (!isRecord(meta)) continue;
    const labels = isRecord(meta['labels']) ? meta['labels'] : undefined;
    const wirePath = join(sessionDir, 'agents', id, 'wire.jsonl');
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
    result.push({
      agentId: id,
      type: normalizeAgentType(meta['type'], id),
      parentAgentId:
        normalizeNonEmptyString(labels?.['parentAgentId']) ??
        normalizeNonEmptyString(meta['parentAgentId']),
      profileName: normalizeNonEmptyString(labels?.['profileName']),
      homedir: join(sessionDir, 'agents', id),
      wireExists: readable,
      wireRecordCount: info.count,
      wireProtocolVersion: info.protocolVersion,
      swarmItem:
        normalizeNonEmptyString(labels?.['swarmItem']) ??
        normalizeNonEmptyString(meta['swarmItem']),
    });
  }
  return result.sort((a, b) => compareAgentIds(a.agentId, b.agentId));
}

async function readState(sessionDir: string): Promise<StateJson | null> {
  for (const candidate of [
    join(sessionDir, 'state.json'),
    join(sessionDir, 'session-meta', 'state.json'),
  ]) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as StateJson;
    } catch {}
  }
  return null;
}

async function findSessionDir(home: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const sessionsRoot = resolve(join(home, 'sessions'));
  const sessionsRootPrefix = sessionsRoot + sep;
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
  } catch {}
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record['type'] !== 'string') continue;
    if (protocolVersion === null) {
      if (record['type'] !== 'metadata') {
        protocolVersion = '1.4';
      } else {
        const version = record['protocol_version'];
        const createdAt = record['created_at'];
        if (typeof version !== 'string' || typeof createdAt !== 'number') {
          throw new TypeError('wire metadata is malformed');
        }
        protocolVersion = version;
      }
    }
    count += 1;
  }
  if (protocolVersion === null) {
    throw new Error('wire file is empty');
  }
  return { count, protocolVersion };
}

function normalizeAgentType(
  value: unknown,
  agentId: string,
): AgentInfo['type'] {
  if (value === 'main' || value === 'sub' || value === 'independent') return value;
  return agentId === 'main' ? 'main' : 'sub';
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recoverWorkDir(state: StateJson, preferred: string): string {
  if (preferred.length > 0) return preferred;
  if (typeof state.cwd === 'string' && state.cwd.length > 0) return state.cwd;
  if (typeof state.workDir === 'string' && state.workDir.length > 0) return state.workDir;
  const customCwd = state.custom?.['cwd'];
  return typeof customCwd === 'string' && customCwd.length > 0 ? customCwd : '';
}

function parseTs(input: string | number | undefined): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (!input) return 0;
  const n = Date.parse(input);
  return Number.isFinite(n) ? n : 0;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
