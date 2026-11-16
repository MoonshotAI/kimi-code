import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { Emitter, type Event } from '#/_base/event';

import { FileArtexArtifactStore } from './fileArtexArtifactStore';
import { reapStaleFileLock, withFileLock } from './fileLock';
import {
  decodeEvidenceBody,
  isBinaryBody as isEvidenceBinaryBody,
  quoteInResponseText,
  quoteMeetsMinRunes,
} from './evidenceVerification';
import {
  isArtexTrafficRole,
  type ArtexExchangeInput,
  type ArtexExchangeMeta,
  type ArtexExchangeRaw,
  type ArtexExternalTrafficInput,
  type ArtexTrafficBinding,
  type ArtexTrafficHostSummary,
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
export const ARTEX_TRAFFIC_MAX_SEARCH_EXCERPT = 4096;

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
  reqBlob?: string;
  respBlob?: string;
  searchExcerpt?: string;
  reqInline?: string;
  respInline?: string;
  index?: string;
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
 * compact metadata, bounded search excerpts, and content-addressed body blobs
 * in FileArtexArtifactStore, plus the relational layer linking a produced finding
 * to the exchanges that support it (role + position + a lightweight snapshot).
 */
export class FileArtexTrafficStore {
  readonly workspaceRoot: string;
  readonly artifacts: FileArtexArtifactStore;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly lockPath: string;
  private readonly captureEmitter = new Emitter<ArtexExchangeMeta>();
  readonly onDidRecord: Event<ArtexExchangeMeta> = this.captureEmitter.event;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.dir = artexTrafficDir(workspaceRoot);
    this.stateFile = artexTrafficStoreFile(workspaceRoot);
    this.lockPath = artexTrafficStoreLockPath(workspaceRoot);
    this.artifacts = new FileArtexArtifactStore(workspaceRoot);
  }

  async record(input: ArtexExchangeInput): Promise<string> {
    const [reqBlob, respBlob] = await Promise.all([
      this.storeBody(input.reqBody),
      this.storeBody(input.respBody),
    ]);
    const searchExcerpt = buildSearchExcerpt(
      input.url,
      input.reqHead,
      input.reqBody,
      headContentType(input.reqHead),
      input.respHead,
      input.respBody,
      input.contentType,
    );
    const meta = await this.mutate((state) => {
      const seq = (state.seq += 1);
      const now = Date.now();
      const id = `${Math.floor(now / 1000)}-${String(seq % 10000).padStart(4, '0')}`;
      const row = buildExchangeRow({
        id,
        ts: Math.floor(now / 1000),
        input,
        reqBlob,
        respBlob,
        searchExcerpt,
      });
      state.exchanges.push(row);
      return toMeta(row);
    });
    this.captureEmitter.fire(meta);
    return meta.id;
  }

  async ingestExternalTraffic(
    entries: ArtexExternalTrafficInput | readonly ArtexExternalTrafficInput[],
  ): Promise<readonly string[]> {
    const list = Array.isArray(entries) ? entries : [entries];
    if (list.length === 0) return [];
    const prepared = await Promise.all(
      list.map(async (entry) => {
        const url = entry.url.trim();
        if (url === '') throw new Error('traffic url must not be empty');
        const method = entry.method.trim().toUpperCase();
        if (method === '') throw new Error('traffic method must not be empty');
        const reqHead = entry.reqHead ?? '';
        const respHead = entry.respHead ?? '';
        const reqBody = toBuffer(entry.reqBody);
        const respBody = toBuffer(entry.respBody);
        const contentType = entry.contentType ?? headContentType(respHead);
        const host = deriveHost(url, entry.host ?? '');
        if (host === '') throw new Error(`cannot resolve host for traffic url: ${url}`);
        const input: ArtexExchangeInput = {
          host,
          method,
          url,
          status: entry.status,
          contentType,
          reqHead,
          respHead,
          reqBody,
          respBody,
        };
        const [reqBlob, respBlob] = await Promise.all([
          this.storeBody(reqBody),
          this.storeBody(respBody),
        ]);
        const searchExcerpt = buildSearchExcerpt(
          url,
          reqHead,
          reqBody,
          headContentType(reqHead),
          respHead,
          respBody,
          contentType,
        );
        return { input, reqBlob, respBlob, searchExcerpt, ts: entry.ts };
      }),
    );
    const metas = await this.mutate((state) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const created: ArtexExchangeMeta[] = [];
      for (const item of prepared) {
        const seq = (state.seq += 1);
        const ts = item.ts !== undefined && item.ts > 0 ? Math.floor(item.ts) : nowSec;
        const id = `${String(ts)}-${String(seq % 10000).padStart(4, '0')}`;
        const row = buildExchangeRow({
          id,
          ts,
          input: item.input,
          reqBlob: item.reqBlob,
          respBlob: item.respBlob,
          searchExcerpt: item.searchExcerpt,
        });
        state.exchanges.push(row);
        created.push(toMeta(row));
      }
      return created;
    });
    for (const meta of metas) {
      this.captureEmitter.fire(meta);
    }
    return metas.map((meta) => meta.id);
  }

  async listHosts(): Promise<readonly ArtexTrafficHostSummary[]> {
    const state = await this.readState();
    const map = new Map<string, { count: number; latestTs: number }>();
    for (const row of state.exchanges) {
      const existing = map.get(row.host);
      if (existing === undefined) {
        map.set(row.host, { count: 1, latestTs: row.ts });
      } else {
        existing.count += 1;
        if (row.ts > existing.latestTs) existing.latestTs = row.ts;
      }
    }
    return [...map.entries()]
      .map(([host, info]) => ({ host, count: info.count, latestTs: info.latestTs }))
      .toSorted((a, b) => b.latestTs - a.latestTs || a.host.localeCompare(b.host));
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
    const candidates = state.exchanges
      .filter((row) => row.host === host)
      .filter((row) => (port === '' ? true : urlAuthorityMatches(row.url, host, port)))
      .filter((row) => (contains === '' ? true : matchesContains(row, contains)))
      .toSorted((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

    if (bodyContains === '') {
      return candidates.slice(page * limit, page * limit + limit).map(toMeta);
    }

    const needed = (page + 1) * limit;
    const matches: ExchangeRow[] = [];
    for (const row of candidates) {
      if (await this.rowMatchesBodyKeyword(row, bodyContains)) {
        matches.push(row);
        if (matches.length >= needed) break;
      }
    }
    return matches.slice(page * limit, page * limit + limit).map(toMeta);
  }

  async get(id: string): Promise<ArtexExchangeRaw | undefined> {
    const state = await this.readState();
    const row = state.exchanges.find((entry) => entry.id === id);
    if (row === undefined) return undefined;
    const [request, response] = await Promise.all([
      this.assembleRaw(row.reqHead, headContentType(row.reqHead), row.reqBlob, row.reqLen, row.reqInline),
      this.assembleRaw(row.respHead, row.contentType, row.respBlob, row.respLen, row.respInline),
    ]);
    return { request, response };
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
    const state = await this.readState();
    const binding = state.bindings
      .map((row) => {
        const snapshot = state.snapshots.find((entry) => entry.id === row.snapshotId);
        return snapshot === undefined ? undefined : { snapshot, row };
      })
      .find((entry) => entry?.snapshot.sourceTrafficId === trafficId);
    if (binding !== undefined) {
      return this.verbatimInSnapshot(binding.snapshot, quote);
    }
    const row = state.exchanges.find((entry) => entry.id === trafficId);
    if (row === undefined) return { found: false, trafficId };
    const raw = await this.fullBodyBytes(row.respInline, row.respBlob);
    return this.verbatimInResponseBody(raw, row.respHead, quote, trafficId);
  }

  async verbatimInSnapshot(
    snapshot: Pick<ArtexTrafficSnapshot, 'respHash' | 'respHead' | 'sourceTrafficId'>,
    quote: string,
  ): Promise<ArtexVerbatimResult> {
    const raw = await this.artifacts.readBody(snapshot.respHash);
    if (raw === undefined) return { found: false, trafficId: snapshot.sourceTrafficId };
    return this.verbatimInResponseBody(raw, snapshot.respHead, quote, snapshot.sourceTrafficId);
  }

  private async verbatimInResponseBody(
    raw: Buffer,
    respHead: string,
    quote: string,
    trafficId: string,
  ): Promise<ArtexVerbatimResult> {
    if (!quoteMeetsMinRunes(quote)) {
      return { found: false, trafficId, side: 'response' };
    }
    let decoded: Buffer;
    try {
      const result = await decodeEvidenceBody(respHead, raw);
      decoded = result.body;
    } catch {
      return { found: false, trafficId, side: 'response' };
    }
    if (isEvidenceBinaryBody(decoded)) {
      return { found: false, trafficId, side: 'response' };
    }
    const text = decoded.toString('utf8');
    if (!quoteInResponseText(text, quote)) return { found: false, trafficId, side: 'response' };
    return { found: true, trafficId, side: 'response' };
  }

  scheduleArtifactCollection(): void {
    void this.collectArtifacts().catch(() => undefined);
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

  private async storeBody(body: Buffer): Promise<string | undefined> {
    if (body.length === 0) return undefined;
    const { hash } = await this.artifacts.writeBody(body);
    return hash;
  }

  private async rowMatchesBodyKeyword(row: ExchangeRow, needle: string): Promise<boolean> {
    if (row.index !== undefined && row.index.includes(needle)) return true;
    if (row.searchExcerpt !== undefined && row.searchExcerpt.includes(needle)) return true;
    if (row.reqBlob !== undefined) {
      const body = await this.artifacts.readBody(row.reqBlob);
      if (
        body !== undefined &&
        !isBinaryBody(headContentType(row.reqHead), body) &&
        body.toString('utf8').toLowerCase().includes(needle)
      ) {
        return true;
      }
    }
    if (row.respBlob !== undefined) {
      const body = await this.artifacts.readBody(row.respBlob);
      if (
        body !== undefined &&
        !isBinaryBody(row.contentType, body) &&
        body.toString('utf8').toLowerCase().includes(needle)
      ) {
        return true;
      }
    }
    return false;
  }

  private async assembleRaw(
    head: string,
    contentType: string,
    blob: string | undefined,
    total: number,
    legacyInline: string | undefined,
  ): Promise<string> {
    if (blob === undefined || blob === '') {
      if (legacyInline !== undefined && legacyInline !== '') {
        return `${head}\n${Buffer.from(legacyInline, 'base64').toString('utf8')}`;
      }
      return `${head}\n`;
    }
    if (total > ARTEX_TRAFFIC_MAX_INLINE_BODY) {
      const range = await this.artifacts.blobRange(blob, 0, ARTEX_TRAFFIC_BLOB_PREVIEW);
      const sample = range?.data ?? Buffer.alloc(0);
      const preview = isBinaryBody(contentType, sample)
        ? binaryTag(contentType, sample, total)
        : sample.toString('utf8');
      return `${head}\n${preview}\n…[truncated] @blob sha256:${blob} (len=${String(total)})`;
    }
    const body = await this.artifacts.readBody(blob);
    if (body === undefined) {
      return `${head}\n…[missing blob] @blob sha256:${blob} (len=${String(total)})`;
    }
    const text = isBinaryBody(contentType, body)
      ? binaryTag(contentType, body, body.length)
      : body.toString('utf8');
    return `${head}\n${text}`;
  }

  private async fullSide(head: string, inline: string | undefined, blob?: string): Promise<string> {
    const body = await this.fullBodyBytes(inline, blob);
    return `${head}\n${body.toString('utf8')}`;
  }

  private async fullBodyBytes(inline: string | undefined, blob?: string): Promise<Buffer> {
    if (blob !== undefined) {
      const full = await this.artifacts.readBody(blob);
      if (full !== undefined) return full;
    }
    if (inline === undefined || inline === '') return Buffer.alloc(0);
    return Buffer.from(inline, 'base64');
  }

  private now(): string {
    return new Date().toISOString();
  }

  private mutate<T>(fn: (state: TrafficState) => T): Promise<T> {
    return withFileLock(
      this.lockPath,
      {
        acquireTimeoutMs: ARTEX_TRAFFIC_LOCK_ACQUIRE_TIMEOUT_MS,
        retryIntervalMs: ARTEX_TRAFFIC_LOCK_RETRY_INTERVAL_MS,
        staleMs: ARTEX_TRAFFIC_LOCK_STALE_MS,
        label: 'artex traffic-store',
      },
      async () => {
        const state = await this.readState();
        const result = fn(state);
        await this.writeState(state);
        return result;
      },
    );
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
    await writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(tmp, this.stateFile);
  }

  private reapStaleLock(): Promise<boolean> {
    return reapStaleFileLock(this.lockPath, ARTEX_TRAFFIC_LOCK_STALE_MS);
  }
}

function buildExchangeRow(input: {
  readonly id: string;
  readonly ts: number;
  readonly input: ArtexExchangeInput;
  readonly reqBlob: string | undefined;
  readonly respBlob: string | undefined;
  readonly searchExcerpt: string;
}): ExchangeRow {
  const host = deriveHost(input.input.url, input.input.host);
  return {
    id: input.id,
    ts: input.ts,
    host,
    method: input.input.method,
    urlTemplate: templatePath(input.input.url),
    url: input.input.url,
    status: input.input.status,
    contentType: input.input.contentType,
    reqLen: input.input.reqBody.length,
    respLen: input.input.respBody.length,
    reqHead: input.input.reqHead,
    respHead: input.input.respHead,
    reqBlob: input.reqBlob,
    respBlob: input.respBlob,
    searchExcerpt: input.searchExcerpt,
  };
}

function deriveHost(url: string, fallback: string): string {
  try {
    return (new URL(url).hostname || fallback).toLowerCase();
  } catch {
    return fallback.toLowerCase();
  }
}

function toBuffer(value: Buffer | string | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function buildSearchExcerpt(
  url: string,
  reqHead: string,
  reqBody: Buffer,
  reqContentType: string,
  respHead: string,
  respBody: Buffer,
  respContentType: string,
): string {
  const halfBodyBudget = Math.floor(ARTEX_TRAFFIC_MAX_SEARCH_EXCERPT / 4);
  const reqText =
    reqBody.length > 0 && !isBinaryBody(reqContentType, reqBody)
      ? reqBody.subarray(0, halfBodyBudget).toString('utf8')
      : '';
  const respText =
    respBody.length > 0 && !isBinaryBody(respContentType, respBody)
      ? respBody.subarray(0, halfBodyBudget).toString('utf8')
      : '';
  const combined = [url, reqHead, reqText, respHead, respText].join('\n').toLowerCase();
  return combined.length <= ARTEX_TRAFFIC_MAX_SEARCH_EXCERPT
    ? combined
    : combined.slice(0, ARTEX_TRAFFIC_MAX_SEARCH_EXCERPT);
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

function binaryTag(contentType: string, body: Buffer, totalLen: number): string {
  const ct = contentType.trim() === '' ? 'application/octet-stream' : contentType.trim();
  const magic = body.subarray(0, 4).toString('hex');
  return `[binary ${ct}, ${String(totalLen)} bytes, magic=${magic}]`;
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
