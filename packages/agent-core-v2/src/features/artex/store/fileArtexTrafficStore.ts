import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';

import { FileArtexArtifactStore } from './fileArtexArtifactStore';
import {
  isArtexTrafficRole,
  type ArtexExchangeInput,
  type ArtexExchangeMeta,
  type ArtexExchangeRaw,
  type ArtexTrafficBinding,
  type ArtexTrafficRef,
  type ArtexTrafficRole,
  type ArtexTrafficSearchQuery,
  type ArtexTrafficSnapshot,
  type ArtexVerbatimResult,
} from './artexTrafficStore';
import {
  ARTEX_TRAFFIC_STORE_SCHEMA_VERSION,
  artexTrafficDir,
  artexTrafficStoreFile,
  artexTrafficStoreLockPath,
} from './paths';

export const ARTEX_TRAFFIC_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
export const ARTEX_TRAFFIC_LOCK_RETRY_INTERVAL_MS = 20;
export const ARTEX_TRAFFIC_LOCK_STALE_MS = 30_000;

export const ARTEX_TRAFFIC_MAX_INLINE_BODY = 256 * 1024;
export const ARTEX_TRAFFIC_BLOB_PREVIEW = 8 * 1024;
export const ARTEX_TRAFFIC_MIN_SEARCH_TERM = 3;
export const ARTEX_TRAFFIC_SNAPSHOT_GRACE_MS = 24 * 60 * 60 * 1000;

interface ExchangeRow {
  id: string;
  ts: number;
  host: string;
  method: string;
  urlTemplate: string;
  url: string;
  status: number;
  contentType: string;
  reqLen: number;
  respLen: number;
  reqHead: string;
  respHead: string;
  reqInline: string;
  reqBlob?: string;
  respInline: string;
  respBlob?: string;
  index: string;
}

interface SnapshotRow extends ArtexTrafficSnapshot {
  createdAt: string;
  unreferencedAt?: string;
}

interface BindingRow {
  id: number;
  findingNodeId: number;
  snapshotId: string;
  role: ArtexTrafficRole;
  note: string;
  position: number;
  createdAt: string;
}

interface TrafficState {
  schemaVersion: number;
  seq: number;
  nextBindingId: number;
  exchanges: ExchangeRow[];
  snapshots: SnapshotRow[];
  bindings: BindingRow[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptyState(): TrafficState {
  return {
    schemaVersion: ARTEX_TRAFFIC_STORE_SCHEMA_VERSION,
    seq: 0,
    nextBindingId: 1,
    exchanges: [],
    snapshots: [],
    bindings: [],
  };
}

/**
 * The file-backed record store for the recording proxy: an exchange index with
 * inline heads/bodies (large bodies spilled to the content-addressed artifact
 * store), plus the relational layer linking a produced finding to the exchanges
 * that support it (role + position + a lightweight snapshot). Evidence bodies are
 * copied into the artifact store when bound, so clearing disposable traffic never
 * takes proof with it.
 */
export class FileArtexTrafficStore {
  readonly workspaceRoot: string;
  readonly artifacts: FileArtexArtifactStore;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly lockPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.dir = artexTrafficDir(workspaceRoot);
    this.stateFile = artexTrafficStoreFile(workspaceRoot);
    this.lockPath = artexTrafficStoreLockPath(workspaceRoot);
    this.artifacts = new FileArtexArtifactStore(workspaceRoot);
  }

  async record(input: ArtexExchangeInput): Promise<string> {
    const req = await this.spill(input.reqBody, headContentType(input.reqHead));
    const resp = await this.spill(input.respBody, input.contentType);
    return this.mutate((state) => {
      const seq = (state.seq += 1);
      const now = Date.now();
      const id = `${Math.floor(now / 1000)}-${String(seq % 10000).padStart(4, '0')}`;
      const url = input.url;
      let host = input.host;
      try {
        host = new URL(url).hostname || input.host;
      } catch {
        host = input.host;
      }
      const index = [url, input.reqHead, req.indexText, input.respHead, resp.indexText]
        .join('\n')
        .toLowerCase();
      state.exchanges.push({
        id,
        ts: Math.floor(now / 1000),
        host,
        method: input.method,
        urlTemplate: templatePath(url),
        url,
        status: input.status,
        contentType: input.contentType,
        reqLen: input.reqBody.length,
        respLen: input.respBody.length,
        reqHead: input.reqHead,
        respHead: input.respHead,
        reqInline: req.inline.toString('base64'),
        reqBlob: req.blob,
        respInline: resp.inline.toString('base64'),
        respBlob: resp.blob,
        index,
      });
      return id;
    });
  }

  async search(query: ArtexTrafficSearchQuery): Promise<readonly ArtexExchangeMeta[]> {
    const state = await this.readState();
    const limit = query.limit === undefined || query.limit <= 0 ? 3 : Math.min(query.limit, 10);
    const page = query.page === undefined || query.page < 0 ? 0 : query.page;
    const { host, port } = normalizeSearchHost(query.host);
    const contains = (query.contains ?? '').trim().toLowerCase();
    const bodyContains = (query.bodyContains ?? '').trim().toLowerCase();
    if (bodyContains !== '' && bodyContains.length < ARTEX_TRAFFIC_MIN_SEARCH_TERM) {
      throw new Error(
        `body search keyword needs at least ${String(ARTEX_TRAFFIC_MIN_SEARCH_TERM)} characters (currently ${String(bodyContains.length)})`,
      );
    }
    const matches = state.exchanges
      .filter((row) => row.host === host)
      .filter((row) => (port === '' ? true : urlAuthorityMatches(row.url, host, port)))
      .filter((row) => (contains === '' ? true : matchesContains(row, contains)))
      .filter((row) => (bodyContains === '' ? true : row.index.includes(bodyContains)))
      .toSorted((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
    return matches.slice(page * limit, page * limit + limit).map(toMeta);
  }

  async get(id: string): Promise<ArtexExchangeRaw | undefined> {
    const state = await this.readState();
    const row = state.exchanges.find((entry) => entry.id === id);
    if (row === undefined) return undefined;
    return {
      request: assembleRaw(row.reqHead, row.reqInline, row.reqBlob, row.reqLen),
      response: assembleRaw(row.respHead, row.respInline, row.respBlob, row.respLen),
    };
  }

  async blobRange(hash: string, offset: number, length: number) {
    return this.artifacts.blobRange(hash, offset, length);
  }

  /** Full byte-for-byte text of both sides, reading spilled bodies from the CAS. */
  async rawBodies(id: string): Promise<{ request: string; response: string } | undefined> {
    const state = await this.readState();
    const row = state.exchanges.find((entry) => entry.id === id);
    if (row === undefined) return undefined;
    return {
      request: await this.fullSide(row.reqHead, row.reqInline, row.reqBlob),
      response: await this.fullSide(row.respHead, row.respInline, row.respBlob),
    };
  }

  /**
   * Checks a quoted snippet appears byte-for-byte in a recorded exchange — the
   * verbatim-quote guard a produced item must pass before a quote counts.
   */
  async verbatimInRecord(trafficId: string, quote: string): Promise<ArtexVerbatimResult> {
    const bodies = await this.rawBodies(trafficId);
    if (bodies === undefined) return { found: false, trafficId };
    if (bodies.request.includes(quote)) return { found: true, trafficId, side: 'request' };
    if (bodies.response.includes(quote)) return { found: true, trafficId, side: 'response' };
    return { found: false, trafficId };
  }

  /**
   * Copies each referenced exchange's bodies into the artifact store and binds a
   * role-labelled, positioned snapshot to the produced finding. Re-binding the
   * same exchange is idempotent; returns the number of new bindings created.
   */
  async bindToFinding(findingNodeId: number, refs: readonly ArtexTrafficRef[]): Promise<number> {
    const normalized = normalizeRefs(refs);
    if (normalized.length === 0) return 0;
    const state = await this.readState();
    const prepared: { ref: ArtexTrafficRef & { role: ArtexTrafficRole }; snapshot: SnapshotRow }[] = [];
    for (const ref of normalized) {
      const row = state.exchanges.find((entry) => entry.id === ref.trafficId);
      if (row === undefined) throw new Error(`traffic ${ref.trafficId} does not exist`);
      const reqBody = await this.fullBodyBytes(row.reqInline, row.reqBlob);
      const respBody = await this.fullBodyBytes(row.respInline, row.respBlob);
      const reqArtifact = await this.artifacts.writeBody(reqBody);
      const respArtifact = await this.artifacts.writeBody(respBody);
      const base: Omit<SnapshotRow, 'id' | 'createdAt'> = {
        sourceTrafficId: row.id,
        capturedAt: row.ts,
        url: row.url,
        method: row.method,
        status: row.status,
        contentType: row.contentType,
        reqHead: row.reqHead,
        respHead: row.respHead,
        reqHash: reqArtifact.hash,
        respHash: respArtifact.hash,
        reqLen: reqArtifact.length,
        respLen: respArtifact.length,
      };
      prepared.push({ ref, snapshot: { ...base, id: snapshotId(base), createdAt: '' } });
    }
    return this.mutate((fresh) => {
      let position =
        fresh.bindings
          .filter((binding) => binding.findingNodeId === findingNodeId)
          .reduce((max, binding) => Math.max(max, binding.position + 1), 0);
      let created = 0;
      for (const { ref, snapshot } of prepared) {
        if (!fresh.snapshots.some((existing) => existing.id === snapshot.id)) {
          fresh.snapshots.push({ ...snapshot, createdAt: this.now() });
        } else {
          for (const existing of fresh.snapshots) {
            if (existing.id === snapshot.id) existing.unreferencedAt = undefined;
          }
        }
        const dup = fresh.bindings.some(
          (binding) => binding.findingNodeId === findingNodeId && binding.snapshotId === snapshot.id,
        );
        if (dup) continue;
        fresh.bindings.push({
          id: fresh.nextBindingId++,
          findingNodeId,
          snapshotId: snapshot.id,
          role: ref.role,
          note: ref.note ?? '',
          position,
          createdAt: this.now(),
        });
        position += 1;
        created += 1;
      }
      return created;
    });
  }

  async findingBindings(findingNodeId: number): Promise<readonly ArtexTrafficBinding[]> {
    const state = await this.readState();
    const byId = new Map(state.snapshots.map((snapshot) => [snapshot.id, snapshot]));
    return state.bindings
      .filter((binding) => binding.findingNodeId === findingNodeId)
      .toSorted((a, b) => a.position - b.position || a.id - b.id)
      .flatMap((binding) => {
        const snapshot = byId.get(binding.snapshotId);
        if (snapshot === undefined) return [];
        return [
          {
            id: binding.id,
            findingNodeId: binding.findingNodeId,
            role: binding.role,
            note: binding.note,
            position: binding.position,
            createdAt: binding.createdAt,
            snapshot: stripSnapshot(snapshot),
          },
        ];
      });
  }

  async count(): Promise<number> {
    return (await this.readState()).exchanges.length;
  }

  /** Reclaims artifact blobs no exchange or snapshot still references. */
  async collectArtifacts(now: number = Date.now()): Promise<number> {
    const state = await this.mutate((fresh) => {
      for (const snapshot of fresh.snapshots) {
        const referenced = fresh.bindings.some((binding) => binding.snapshotId === snapshot.id);
        if (referenced) {
          snapshot.unreferencedAt = undefined;
        } else if (snapshot.unreferencedAt === undefined) {
          snapshot.unreferencedAt = this.now();
        }
      }
      fresh.snapshots = fresh.snapshots.filter((snapshot) => {
        if (fresh.bindings.some((binding) => binding.snapshotId === snapshot.id)) return true;
        const since = snapshot.unreferencedAt ? Date.parse(snapshot.unreferencedAt) : now;
        return now - since < ARTEX_TRAFFIC_SNAPSHOT_GRACE_MS;
      });
      return fresh;
    });
    const live = new Set<string>();
    for (const row of state.exchanges) {
      if (row.reqBlob) live.add(row.reqBlob);
      if (row.respBlob) live.add(row.respBlob);
    }
    for (const snapshot of state.snapshots) {
      live.add(snapshot.reqHash);
      live.add(snapshot.respHash);
    }
    return this.artifacts.collect(live, now);
  }

  private async spill(
    body: Buffer,
    contentType: string,
  ): Promise<{ inline: Buffer; blob?: string; indexText: string }> {
    if (body.length === 0) return { inline: Buffer.alloc(0), indexText: '' };
    const text = !isBinaryBody(contentType, body);
    const indexText = text ? body.toString('utf8') : '';
    if (body.length <= ARTEX_TRAFFIC_MAX_INLINE_BODY) {
      return { inline: body, indexText };
    }
    const { hash } = await this.artifacts.writeBody(body);
    const inline = text
      ? Buffer.from(body.subarray(0, ARTEX_TRAFFIC_BLOB_PREVIEW))
      : Buffer.from(binaryTag(contentType, body));
    return { inline, blob: hash, indexText };
  }

  private async fullSide(head: string, inline: string, blob?: string): Promise<string> {
    const body = await this.fullBodyBytes(inline, blob);
    return `${head}\n${body.toString('utf8')}`;
  }

  private async fullBodyBytes(inline: string, blob?: string): Promise<Buffer> {
    if (blob !== undefined) {
      const full = await this.artifacts.readBody(blob);
      if (full !== undefined) return full;
    }
    return Buffer.from(inline, 'base64');
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async mutate<T>(fn: (state: TrafficState) => T): Promise<T> {
    const token = await this.acquireLock();
    try {
      const state = await this.readState();
      const result = fn(state);
      await this.writeState(state);
      return result;
    } finally {
      await this.releaseLock(token);
    }
  }

  private async readState(): Promise<TrafficState> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    const parsed = JSON.parse(raw) as TrafficState;
    return { ...emptyState(), ...parsed };
  }

  private async writeState(state: TrafficState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${String(process.pid)}-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.stateFile);
  }

  private async acquireLock(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + ARTEX_TRAFFIC_LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(`pid=${String(process.pid)} since=${this.now()} token=${token}`, 'utf8');
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.reapStaleLock();
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring artex traffic-store lock at ${this.lockPath}`, {
            cause: error,
          });
        }
        await delay(ARTEX_TRAFFIC_LOCK_RETRY_INTERVAL_MS);
      }
    }
  }

  private async reapStaleLock(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    const pid = Number(/pid=(\d+)/.exec(content)?.[1]);
    const since = Date.parse(/since=(\S+)/.exec(content)?.[1] ?? '');
    const dead = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && this.pidIsDead(pid);
    const expired = Number.isFinite(since) && Date.now() - since > ARTEX_TRAFFIC_LOCK_STALE_MS;
    if (dead || expired) {
      await rm(this.lockPath, { force: true });
    }
  }

  private pidIsDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async releaseLock(token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    if (!content.includes(`token=${token}`)) return;
    await rm(this.lockPath, { force: true });
  }
}

function toMeta(row: ExchangeRow): ArtexExchangeMeta {
  return {
    id: row.id,
    ts: row.ts,
    host: row.host,
    method: row.method,
    url: row.url,
    status: row.status,
    contentType: row.contentType,
    respLen: row.respLen,
  };
}

function matchesContains(row: ExchangeRow, contains: string): boolean {
  return row.url.toLowerCase().includes(contains) || row.urlTemplate.toLowerCase().includes(contains);
}

function assembleRaw(head: string, inline: string, blob: string | undefined, total: number): string {
  const body = Buffer.from(inline, 'base64').toString('utf8');
  let out = `${head}\n${body}`;
  if (blob !== undefined && blob !== '') {
    out += `\n…[truncated] @blob sha256:${blob} (len=${String(total)})`;
  }
  return out;
}

function normalizeRefs(refs: readonly ArtexTrafficRef[]): (ArtexTrafficRef & { role: ArtexTrafficRole })[] {
  const out: (ArtexTrafficRef & { role: ArtexTrafficRole })[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const trafficId = ref.trafficId.trim();
    if (trafficId === '') throw new Error('traffic_id must not be empty');
    const role = ref.role === undefined || ref.role === '' ? 'supporting' : ref.role;
    if (!isArtexTrafficRole(role)) throw new Error(`invalid traffic role "${role}"`);
    if (seen.has(trafficId)) continue;
    seen.add(trafficId);
    out.push({ trafficId, role, note: ref.note });
  }
  return out;
}

function snapshotId(snapshot: Omit<SnapshotRow, 'id' | 'createdAt'>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function stripSnapshot(row: SnapshotRow): ArtexTrafficSnapshot {
  return {
    id: row.id,
    sourceTrafficId: row.sourceTrafficId,
    capturedAt: row.capturedAt,
    url: row.url,
    method: row.method,
    status: row.status,
    contentType: row.contentType,
    reqHead: row.reqHead,
    respHead: row.respHead,
    reqHash: row.reqHash,
    respHash: row.respHash,
    reqLen: row.reqLen,
    respLen: row.respLen,
  };
}

const BINARY_TYPE_PREFIXES: readonly string[] = [
  'image/',
  'audio/',
  'video/',
  'font/',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/pdf',
  'application/wasm',
];

function isBinaryBody(contentType: string, body: Buffer): boolean {
  let ct = contentType.toLowerCase().trim();
  const semi = ct.indexOf(';');
  if (semi >= 0) ct = ct.slice(0, semi).trim();
  if (BINARY_TYPE_PREFIXES.some((prefix) => ct.startsWith(prefix))) return true;
  return body.subarray(0, 512).includes(0);
}

function headContentType(head: string): string {
  const match = /^content-type:\s*(.+)$/im.exec(head);
  return match ? (match[1] ?? '').trim() : '';
}

function binaryTag(contentType: string, body: Buffer): string {
  const ct = contentType.trim() === '' ? 'application/octet-stream' : contentType.trim();
  const magic = body.subarray(0, 4).toString('hex');
  return `[binary ${ct}, ${String(body.length)} bytes, magic=${magic}]`;
}

function templatePath(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    const q = url.indexOf('?');
    path = q >= 0 ? url.slice(0, q) : url;
  }
  return path
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? '{id}' : segment))
    .join('/');
}

function normalizeSearchHost(raw: string): { host: string; port: string } {
  const value = raw.trim();
  if (value === '') throw new Error('host is a required parameter');
  let host = value;
  let port = '';
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      host = url.hostname;
      port = url.port;
    } catch {
      throw new Error(`cannot parse host: ${value}`);
    }
  } else {
    const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(value);
    if (match) {
      host = match[1] ?? value;
      port = match[2] ?? '';
    }
  }
  host = host.replaceAll(/^\[|\]$/g, '').trim().toLowerCase();
  if (host === '') throw new Error(`cannot parse host: ${value}`);
  if (port !== '') {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`invalid port: ${port}`);
    }
  }
  return { host, port };
}

function urlAuthorityMatches(url: string, host: string, port: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === host && (parsed.port || defaultPort(parsed.protocol)) === port;
  } catch {
    return false;
  }
}

function defaultPort(protocol: string): string {
  switch (protocol) {
    case 'https:':
      return '443';
    case 'http:':
      return '80';
    default:
      return '';
  }
}
