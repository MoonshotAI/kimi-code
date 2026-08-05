import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

import type {
  IBootstrapService,
  ILogService,
  ISessionIndex,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { MiniDb } from '@moonshot-ai/minidb';
import { TranscriptStore, type TranscriptOperation } from '@moonshot-ai/transcript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GlobalSearchError,
  GlobalSearchService,
  drainGlobalSearchDisposals,
  type LiveTranscriptSource,
} from '../../src/search/searchService';

// ---------------------------------------------------------------------------
// fixtures & stubs
// ---------------------------------------------------------------------------

const WS = 'ws_test';

const T1 = 1_700_000_000_000;
const T2 = 1_700_000_100_000;
const T3 = 1_700_000_200_000;

function summary(id: string, title: string, updatedAt = T1): SessionSummary {
  return { id, workspaceId: WS, title, createdAt: updatedAt, updatedAt, archived: false };
}

function makeBootstrap(home: string): IBootstrapService {
  return {
    homeDir: home,
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
}

function makeSessionIndex(list: ISessionIndex['listRecent']): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: async () => ({ state: 'uninitialized', degradedCount: 0 }),
    status: () => ({ state: 'uninitialized', degradedCount: 0 }),
    listRecent: list,
    get: async () => undefined,
    count: async () => 0,
    remove: async () => {},
  };
}

function staticIndex(summaries: SessionSummary[]): ISessionIndex {
  return makeSessionIndex(async () => ({ items: summaries, nextCursor: undefined }));
}

function userLine(text: string, time: number, origin?: unknown): string {
  return JSON.stringify({
    type: 'context.append_message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: origin ?? { kind: 'user' },
    },
  });
}

function assistantLine(text: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', part: { type: 'text', text } },
  });
}

function stepBeginLine(uuid: string, step: number, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'step.begin', uuid, turnId: '0', step },
  });
}

function assistantStepLine(text: string, stepUuid: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', stepUuid, part: { type: 'text', text } },
  });
}

function rawRecord(value: unknown): string {
  return JSON.stringify(value);
}

async function writeWire(
  home: string,
  sessionId: string,
  agentId: string,
  lines: string[],
): Promise<string> {
  const dir = join(home, 'sessions', WS, sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'wire.jsonl');
  await writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return file;
}

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

function makeService(home: string, index: ISessionIndex): GlobalSearchService {
  const service = new GlobalSearchService(index, makeBootstrap(home), noopLog);
  service.syncDebounceMs = 0;
  return service;
}

// ---------------------------------------------------------------------------
// test-only drives for the background coordinator / private internals
// ---------------------------------------------------------------------------

/** Join or start a sync pass (single-flight, so this is exactly "sync now"). */
function syncNow(service: GlobalSearchService): Promise<void> {
  return (service as unknown as { ensureSyncStarted(): Promise<void> }).ensureSyncStarted();
}

/**
 * Deterministic sync after a fixture mutation: searches KICK fire-and-forget
 * passes that may still be in flight (started before the mutation), so join
 * any in-flight pass first, then run one more that is guaranteed to start
 * after the mutation landed.
 */
async function settleSync(service: GlobalSearchService): Promise<void> {
  await syncNow(service);
  await syncNow(service);
}

/** Drive the read-only refresh (fingerprint check + WAL catch-up / reopen). */
function refreshNow(service: GlobalSearchService): Promise<void> {
  return (service as unknown as { refreshReadonly(): Promise<void> }).refreshReadonly();
}

interface ServiceInternals {
  db: {
    get(key: string): Record<string, unknown> | undefined;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
    batch(ops: { op: 'set' | 'del'; key: string; value?: unknown }[]): Promise<void>;
    query(criteria: { key: { prefix: string }; project?: string[] }): {
      key: string;
      value: Record<string, unknown>;
    }[];
    compact(): Promise<void>;
    close(): Promise<void>;
  } | null;
  generation: number;
  syncPromise: Promise<void> | null;
  fileMetaMigrated: boolean;
  doRefreshReadonly(): Promise<void>;
  syncSession(db: NonNullable<ServiceInternals['db']>, summary: SessionSummary): Promise<void>;
  openSearchDb(): Promise<unknown>;
  computeFingerprint(): Promise<string>;
}

function internals(service: GlobalSearchService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

/**
 * Let pending promise chains and fs I/O settle without awaiting anything
 * specific — backs the "still not drained" assertions: a drain that failed
 * to wait would have resolved within these rounds.
 */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Patch a private async method to signal its first entry and hold it until
 * released — the deterministic "dispose lands mid-op" interleaving for the
 * lifecycle tests. Later calls pass through to the original.
 */
function blockFirstCall(
  service: GlobalSearchService,
  method: 'deleteSessionDocs' | 'computeFingerprint',
): { entered: Promise<void>; release: () => void } {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const host = service as unknown as Record<string, unknown>;
  const orig = host[method] as (this: unknown, ...args: unknown[]) => Promise<unknown>;
  let first = true;
  host[method] = async function (this: unknown, ...args: unknown[]) {
    if (first) {
      first = false;
      enteredResolve();
      await gate;
    }
    return orig.apply(this, args);
  };
  return { entered, release: () => releaseResolve() };
}

/** An ILogService that records warn calls (message + serialized meta). */
function recordingLog(): { log: ILogService; warnings: string[] } {
  const warnings: string[] = [];
  const log = {
    error: () => {},
    warn: (message: string, meta?: unknown) => warnings.push(`${message} ${JSON.stringify(meta)}`),
    info: () => {},
    debug: () => {},
  } as unknown as ILogService;
  return { log, warnings };
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('GlobalSearchService', () => {
  let home: string | undefined;
  const services: GlobalSearchService[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-search-'));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await drainGlobalSearchDisposals();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  function track(service: GlobalSearchService): GlobalSearchService {
    services.push(service);
    return service;
  }

  it('indexes user and assistant text and finds Chinese and English terms', async () => {
    const s1 = summary('s1', '搜索重构讨论', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('帮我看看苹果怎么挑', T1),
      assistantLine('Here is the apple picking guide.', T2),
      userLine('忽略我', T3, { kind: 'injection', variant: 'reminder' }),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const cn = await service.search({ query: '苹果' });
    expect(cn.items.length).toBeGreaterThan(0);
    const cnHit = cn.items[0]!;
    expect(cnHit.sessionId).toBe('s1');
    expect(cnHit.workspaceId).toBe(WS);
    expect(cnHit.sessionTitle).toBe('搜索重构讨论');
    expect(cnHit.agentId).toBe('main');
    expect(cnHit.role).toBe('user');
    expect(cnHit.snippet).toContain('苹果');
    expect(cnHit.time).toBe(T1);
    expect(cnHit.score).toBeGreaterThan(0);

    const en = await service.search({ query: 'apple' });
    expect(en.items.some((h) => h.role === 'assistant')).toBe(true);

    // The injection-origin user message must NOT be indexed.
    const injected = await service.search({ query: '忽略我' });
    expect(injected.items).toEqual([]);
  });

  it('hits session titles as title docs', async () => {
    const s1 = summary('s1', '季度总结报告', T1);
    await writeWire(home!, 's1', 'main', [userLine('随便说点什么', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '季度' });
    const titleHit = page.items.find((h) => h.role === 'title');
    expect(titleHit).toBeDefined();
    expect(titleHit?.sessionId).toBe('s1');
    expect(titleHit?.snippet).toContain('季度');
  });

  it('filters by container (session and agent)', async () => {
    const s1 = summary('s1', 'one', T1);
    const s2 = summary('s2', 'two', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 from s1', T1)]);
    await writeWire(home!, 's2', 'main', [userLine('苹果 from s2 main', T1)]);
    await writeWire(home!, 's2', 'agent-1', [userLine('苹果 from s2 subagent', T1)]);
    const service = track(makeService(home!, staticIndex([s1, s2])));
    await service.reindex();

    const all = await service.search({ query: '苹果' });
    expect(all.items.length).toBe(3);

    const inS2 = await service.search({ query: '苹果', container: { sessionId: 's2' } });
    expect(inS2.items.length).toBe(2);
    expect(inS2.items.every((h) => h.sessionId === 's2')).toBe(true);

    const inSub = await service.search({
      query: '苹果',
      container: { sessionId: 's2', agentId: 'agent-1' },
    });
    expect(inSub.items.length).toBe(1);
    expect(inSub.items[0]?.agentId).toBe('agent-1');
  });

  it('filters by role and time range', async () => {
    const s1 = summary('s1', 'roles', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 early', T1),
      assistantLine('苹果 middle', T2),
      userLine('苹果 late', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const users = await service.search({ query: '苹果', role: 'user' });
    expect(users.items.length).toBe(2);
    expect(users.items.every((h) => h.role === 'user')).toBe(true);

    const ranged = await service.search({ query: '苹果', startTime: T2, endTime: T2 });
    expect(ranged.items.length).toBe(1);
    expect(ranged.items[0]?.time).toBe(T2);
  });

  it('sorts by time in both directions', async () => {
    const s1 = summary('s1', 'sort', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 one', T1),
      userLine('苹果 two', T2),
      userLine('苹果 three', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const desc = await service.search({ query: '苹果', sort: 'time_desc' });
    expect(desc.items.map((h) => h.time)).toEqual([T3, T2, T1]);
    const asc = await service.search({ query: '苹果', sort: 'time_asc' });
    expect(asc.items.map((h) => h.time)).toEqual([T1, T2, T3]);
  });

  it('paginates with an opaque cursor and rejects changed conditions', async () => {
    const s1 = summary('s1', 'paging', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 one', T1),
      userLine('苹果 two', T2),
      userLine('苹果 three', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page1 = await service.search({ query: '苹果', sort: 'time_asc', pageSize: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.pageToken).toBeDefined();

    const page2 = await service.search({
      query: '苹果',
      sort: 'time_asc',
      pageSize: 2,
      pageToken: page1.pageToken,
    });
    expect(page2.items.length).toBe(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.pageToken).toBeUndefined();

    const times = [...page1.items, ...page2.items].map((h) => h.time);
    expect(new Set(times).size).toBe(3);

    // Same token with a changed query condition → parameter error.
    await expect(
      service.search({ query: '香蕉', sort: 'time_asc', pageToken: page1.pageToken }),
    ).rejects.toMatchObject({ reason: 'invalid_page_token' });
    // Malformed token.
    await expect(service.search({ query: '苹果', pageToken: '!!!' })).rejects.toBeInstanceOf(
      GlobalSearchError,
    );
  });

  it('picks up appended wire lines on the next sync pass', async () => {
    const s1 = summary('s1', 'incremental', T1);
    const file = await writeWire(home!, 's1', 'main', [userLine('苹果 initial', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    await appendFile(file, `${userLine('苹果 appended', T2)}\n`, 'utf8');
    // Searches no longer await a sync — drive the coordinator explicitly.
    await settleSync(service);
    const page = await service.search({ query: '苹果' });
    expect(page.items.length).toBe(2);
    expect(page.items.some((h) => h.snippet.includes('appended'))).toBe(true);
  });

  it('reports indexState building before the first full sync and ready after', async () => {
    const s1 = summary('s1', 'state', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 state', T1)]);

    // Block the session enumeration until released, so the constructor's
    // background sync cannot finish before the first search.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const index = makeSessionIndex(async () => {
      await gate;
      return { items: [s1], nextCursor: undefined };
    });
    const service = track(makeService(home!, index));

    const building = await service.search({ query: '苹果' });
    expect(building.indexState.state).toBe('building');
    expect(building.items).toEqual([]);

    release();
    await service.reindex();
    const ready = await service.search({ query: '苹果' });
    expect(ready.indexState.state).toBe('ready');
    expect(ready.indexState.indexedSessions).toBe(1);
    expect(ready.indexState.totalSessions).toBe(1);
    expect(ready.indexState.documents).toBe(2); // 1 message + 1 title doc
  });

  it('drops docs of sessions that disappear between syncs', async () => {
    const s1 = summary('s1', 'gone', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 ephemeral', T1)]);
    const sessions = [s1];
    const service = track(
      makeService(
        home!,
        makeSessionIndex(async () => ({ items: sessions, nextCursor: undefined })),
      ),
    );
    await service.reindex();
    expect((await service.search({ query: '苹果' })).items.length).toBe(1);

    sessions.length = 0; // session directory vanished from the index
    await settleSync(service);
    const page = await service.search({ query: '苹果' });
    expect(page.items).toEqual([]);
  });

  it('rescans a wire file that shrank between syncs', async () => {
    const s1 = summary('s1', 'shrink', T1);
    const file = await writeWire(home!, 's1', 'main', [
      userLine('苹果 old one', T1),
      userLine('苹果 old two', T2),
      userLine('苹果 old three', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();
    expect((await service.search({ query: '苹果' })).items.length).toBe(3);

    // Rewrite with a shorter file: stale docs must be dropped and the new
    // content rescanned from offset 0.
    await writeFile(file, `${userLine('香蕉 fresh', T1)}\n`, 'utf8');
    await settleSync(service);
    const stale = await service.search({ query: '苹果' });
    expect(stale.items).toEqual([]);
    const fresh = await service.search({ query: '香蕉' });
    expect(fresh.items.length).toBe(1);
    expect(fresh.items[0]?.snippet).toContain('fresh');
  });

  it('does not advance the watermark past an incomplete trailing line', async () => {
    const s1 = summary('s1', 'tail', T1);
    const file = await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    // A partial line (no trailing newline) must not be indexed nor consumed.
    await appendFile(file, userLine('苹果 partial', T2), 'utf8');
    await settleSync(service);
    expect((await service.search({ query: 'partial' })).items).toEqual([]);

    // Once the line is completed, the next pass picks it up.
    await appendFile(file, '\n', 'utf8');
    await settleSync(service);
    const page = await service.search({ query: 'partial' });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.role).toBe('user');
  });

  it('indexes legacy root and v2 agents layouts of one session without key collisions', async () => {
    const s1 = summary('s1', 'dual layout', T1);
    // Legacy v1 layout: <sessionDir>/wire.jsonl; v2 layout: agents/main/wire.jsonl.
    await writeWire(home!, 's1', 'main', [userLine('苹果 from agents', T2)]);
    await writeFile(
      join(home!, 'sessions', WS, 's1', 'wire.jsonl'),
      `${userLine('苹果 from root', T1)}\n`,
      'utf8',
    );
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', sort: 'time_asc', role: 'user' });
    expect(page.items.length).toBe(2);
    expect(page.items.every((h) => h.agentId === 'main')).toBe(true);
    const snippets = page.items.map((h) => h.snippet);
    expect(snippets.some((s) => s.includes('root'))).toBe(true);
    expect(snippets.some((s) => s.includes('agents'))).toBe(true);
  });

  it('rejects a pageToken that decodes to a non-object', async () => {
    const s1 = summary('s1', 'token', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 token', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    for (const payload of ['null', '42', '"str"', '[1,2]']) {
      const token = Buffer.from(payload).toString('base64url');
      await expect(service.search({ query: '苹果', pageToken: token })).rejects.toMatchObject({
        reason: 'invalid_page_token',
      });
    }
  });

  it('drops docs of a wire file that disappears while its session remains', async () => {
    const s1 = summary('s1', 'file gone', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 main agent', T1)]);
    const subFile = await writeWire(home!, 's1', 'agent-1', [userLine('苹果 sub agent', T2)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();
    expect((await service.search({ query: '苹果' })).items.length).toBe(2);

    await rm(subFile);
    await settleSync(service);
    const page = await service.search({ query: '苹果' });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.agentId).toBe('main');
  });

  it('runs a second instance read-only and catches up from the WAL', async () => {
    const s1 = summary('s1', 'shared', T1);
    const file = await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
    const index = staticIndex([s1]);

    const writer = track(makeService(home!, index));
    await writer.reindex();

    // Same process, same homeDir: the lock is held by `writer`, so this
    // instance must downgrade to read-only instead of rebuilding.
    const reader = track(makeService(home!, index));
    const status = await reader.status();
    expect(status.documents).toBe(2); // replayed at open: message + title

    const first = await reader.search({ query: '苹果' });
    expect(first.indexState.state).toBe('readonly');
    expect(first.items.length).toBe(1);

    // The writer indexes a new line. The reader's search must NOT wait for
    // the refresh: it serves the stale view (flagged) and refreshes in the
    // background; the catchUpFromWal replay lands for the next search.
    await appendFile(file, `${userLine('苹果 delta', T2)}\n`, 'utf8');
    await settleSync(writer);
    const stalePage = await reader.search({ query: '苹果' });
    expect(stalePage.items.length).toBe(1);
    expect(stalePage.indexState.stale).toBe(true);
    await refreshNow(reader);
    const caughtUp = await reader.search({ query: '苹果' });
    expect(caughtUp.items.length).toBe(2);
    expect(caughtUp.items.some((h) => h.snippet.includes('delta'))).toBe(true);
    expect(caughtUp.indexState.stale).toBeUndefined();

    // WAL rotation on the writer forces the reader's reopen path (open the
    // replacement, then swap); results stay correct afterwards.
    const writerDb = internals(writer).db;
    await writerDb?.compact();
    await refreshNow(reader);
    const afterRotation = await reader.search({ query: '苹果' });
    expect(afterRotation.items.length).toBe(2);
  });

  it('rejects reindex on a read-only instance', async () => {
    const s1 = summary('s1', 'lock', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 lock', T1)]);
    const index = staticIndex([s1]);
    const writer = track(makeService(home!, index));
    await writer.reindex();

    const reader = track(makeService(home!, index));
    await expect(reader.reindex()).rejects.toMatchObject({ reason: 'readonly_index' });
  });

  // -- base-building contract (deferred open-time build) ----------------------

  it('serves the building page while the index base is rebuilding, real hits after commit', async () => {
    const s1 = summary('s1', 'shared', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    // Force the base-building state on the served handle (the deferred
    // open-time build sets exactly this): searches must return the building
    // page — never throw, never silently serve partial results.
    const db = internals(service).db as unknown as { textIndexBuilding(name: string): boolean };
    const original = db.textIndexBuilding.bind(db);
    db.textIndexBuilding = () => true;
    try {
      const building = await service.search({ query: '苹果' });
      expect(building.indexState.state).toBe('building');
      expect(building.indexState.stale).toBe(true);
      expect(building.items).toEqual([]);
      expect(building.pageToken).toBeUndefined();
      // Literal mode (the tri index) takes the same building path.
      const buildingLiteral = await service.search({ query: '苹果', mode: 'literal' });
      expect(buildingLiteral.indexState.state).toBe('building');
      expect(buildingLiteral.items).toEqual([]);
    } finally {
      db.textIndexBuilding = original;
    }

    // The build "committed": the same queries serve real hits again.
    const ready = await service.search({ query: '苹果' });
    expect(ready.items.length).toBe(1);
    expect(ready.indexState.state).toBe('ready');
  });

  it('read-only instance serves the building page while its base is rebuilding', async () => {
    const s1 = summary('s1', 'shared', T1);
    await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
    const index = staticIndex([s1]);
    const writer = track(makeService(home!, index));
    await writer.reindex();
    const reader = track(makeService(home!, index));
    await reader.status(); // forces the read-only open

    const db = internals(reader).db as unknown as { textIndexBuilding(name: string): boolean };
    const original = db.textIndexBuilding.bind(db);
    db.textIndexBuilding = () => true;
    try {
      const building = await reader.search({ query: '苹果' });
      expect(building.indexState.state).toBe('building');
      expect(building.items).toEqual([]);
    } finally {
      db.textIndexBuilding = original;
    }
    const ready = await reader.search({ query: '苹果' });
    expect(ready.items.length).toBe(1);
    expect(ready.indexState.state).toBe('readonly');
  });

  // -- turn ordinals ------------------------------------------------------------

  it('assigns 0-based turn ordinals to user and assistant hits', async () => {
    const s1 = summary('s1', 'turns', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 question zero', T1),
      assistantLine('苹果 answer zero', T2),
      userLine('苹果 question one', T3),
      assistantLine('苹果 answer one', T3 + 1000),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const users = await service.search({ query: '苹果', role: 'user', sort: 'time_asc' });
    expect(users.items.map((h) => h.turn)).toEqual([0, 1]);
    const assistants = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    expect(assistants.items.map((h) => h.turn)).toEqual([0, 1]);
  });

  it('counts turns independently of indexing (text-less prompts, hidden & marker origins)', async () => {
    const s1 = summary('s1', 'counting', T1);
    await writeWire(home!, 's1', 'main', [
      // Pure-image user prompt: not indexed, but opens turn 0.
      rawRecord({
        type: 'context.append_message',
        time: T1,
        message: { role: 'user', content: [{ type: 'image', source: { kind: 'url', url: 'x' } }] },
      }),
      // Injection: no turn.
      userLine('苹果 injected', T1 + 100, { kind: 'injection', variant: 'reminder' }),
      // Turn-opening system trigger: opens turn 2 (promptless), not indexed.
      userLine('苹果 continuation', T1 + 200, {
        kind: 'system_trigger',
        name: 'goal_continuation',
      }),
      // Marker without user-slash: no turn.
      userLine('苹果 skill noise', T1 + 300, { kind: 'skill_activation', trigger: 'model-tool' }),
      userLine('苹果 typed', T2, { kind: 'user' }),
      // user-slash skill: indexed AND opens turn 4.
      userLine('/commit 苹果 ship it', T3, { kind: 'skill_activation', trigger: 'user-slash' }),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', sort: 'time_asc' });
    const bySnippet = (needle: string) =>
      page.items.find((h) => h.snippet.includes(needle) && h.role === 'user');
    expect(bySnippet('injected')).toBeUndefined(); // filtered out of the index
    expect(bySnippet('continuation')).toBeUndefined();
    expect(bySnippet('skill noise')).toBeUndefined();
    expect(bySnippet('typed')?.turn).toBe(2); // image=0, injection=–, trigger=1
    expect(bySnippet('ship it')?.turn).toBe(3);
  });

  it('attaches assistant content to a fallback turn when no prompt opened one', async () => {
    const s1 = summary('s1', 'fallback', T1);
    await writeWire(home!, 's1', 'main', [
      assistantLine('苹果 orphan answer', T1),
      userLine('苹果 later question', T2),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', sort: 'time_asc' });
    expect(page.items.map((h) => [h.role, h.turn])).toEqual([
      ['assistant', 0],
      ['user', 1],
    ]);
  });

  it('keeps the turn counter across incremental sync passes', async () => {
    const s1 = summary('s1', 'resume', T1);
    const file = await writeWire(home!, 's1', 'main', [
      userLine('苹果 first', T1),
      assistantLine('苹果 first reply', T2),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    await appendFile(
      file,
      `${userLine('苹果 second', T3)}\n${assistantLine('苹果 second reply', T3 + 1000)}\n`,
      'utf8',
    );
    await settleSync(service);
    const page = await service.search({ query: '苹果', sort: 'time_asc' });
    expect(page.items.map((h) => [h.role, h.turn])).toEqual([
      ['user', 0],
      ['assistant', 0],
      ['user', 1],
      ['assistant', 1],
    ]);
  });

  it('restarts the turn counter when a shrunk file is rescanned', async () => {
    const s1 = summary('s1', 'shrink turns', T1);
    const file = await writeWire(home!, 's1', 'main', [
      userLine('苹果 a', T1),
      userLine('苹果 b', T2),
      userLine('苹果 c', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();
    expect(
      (await service.search({ query: '苹果', sort: 'time_asc' })).items.map((h) => h.turn),
    ).toEqual([0, 1, 2]);

    await writeFile(file, `${userLine('苹果 only', T1)}\n`, 'utf8');
    await settleSync(service);
    const page = await service.search({ query: '苹果' });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.turn).toBe(0);
  });

  it('rewinds the counter on context.undo and renumbers after it', async () => {
    const s1 = summary('s1', 'undo', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 before', T1),
      assistantLine('苹果 before reply', T2),
      userLine('苹果 undone', T3),
      assistantLine('苹果 undone reply', T3 + 1000),
      rawRecord({ type: 'context.undo', time: T3 + 2000, count: 1 }),
      userLine('苹果 redone', T3 + 3000),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', sort: 'time_asc' });
    const bySnippet = (needle: string) => page.items.find((h) => h.snippet.includes(needle));
    expect(bySnippet('before')?.turn).toBe(0);
    // The undone turn's docs keep their pre-undo ordinal (transcript no longer
    // shows them — accepted deviation), and the redo reuses ordinal 1.
    expect(bySnippet('undone reply')?.turn).toBe(1);
    expect(bySnippet('redone')?.turn).toBe(1);
  });

  it('keeps numbering monotonic across context.apply_compaction', async () => {
    const s1 = summary('s1', 'compaction', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 before compaction', T1),
      assistantLine('苹果 old reply', T2),
      // The transcript's cold replay keeps full history (the compaction becomes
      // a `compaction_summary` marker message) and groupTurns numbers it
      // continuously — so the indexer must NOT reset its counter either.
      rawRecord({
        type: 'context.apply_compaction',
        time: T3,
        summary: 'condensed',
        compactedCount: 2,
      }),
      userLine('summary', T3 + 1000, { kind: 'compaction_summary' }),
      // Assistant content right after the compaction marker still attaches to
      // the pre-compaction turn (the marker does not open one).
      assistantLine('苹果 post-compaction reply', T3 + 1500),
      userLine('苹果 after compaction', T3 + 2000),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', sort: 'time_asc' });
    const bySnippet = (needle: string) => page.items.find((h) => h.snippet.includes(needle));
    expect(bySnippet('before compaction')?.turn).toBe(0);
    expect(bySnippet('old reply')?.turn).toBe(0);
    expect(bySnippet('post-compaction reply')?.turn).toBe(0);
    expect(bySnippet('after compaction')?.turn).toBe(1);
  });

  // -- step ids ---------------------------------------------------------------

  it('assigns transcript step ids to assistant hits; user and title hits carry none', async () => {
    const s1 = summary('s1', '苹果 steps', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 question', T1),
      stepBeginLine('u1', 1, T1 + 100),
      assistantStepLine('苹果 first draft', 'u1', T1 + 200),
      // A vacuous step: begins but owns no text — no document, and the next
      // step keeps the wire's original ordinal (live numbering, gaps allowed).
      stepBeginLine('u2', 2, T1 + 300),
      stepBeginLine('u3', 3, T1 + 400),
      assistantStepLine('苹果 second draft', 'u3', T1 + 500),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const assistants = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    expect(assistants.items.map((h) => [h.turn, h.stepId])).toEqual([
      [0, 't0.1'],
      [0, 't0.3'],
    ]);

    const users = await service.search({ query: '苹果', role: 'user' });
    expect(users.items[0]?.stepId).toBeUndefined();
    const title = await service.search({ query: '苹果', role: 'title' });
    expect(title.items[0]?.stepId).toBeUndefined();
  });

  it('omits step ids when no matching step.begin was seen', async () => {
    const s1 = summary('s1', 'orphans', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 question', T1),
      // A stepUuid the tracker never saw a begin for…
      assistantStepLine('苹果 orphan', 'unknown-uuid', T2),
      // …and a legacy record with no stepUuid at all.
      assistantLine('苹果 legacy', T3),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    expect(page.items.map((h) => [h.turn, h.stepId])).toEqual([
      [0, undefined],
      [0, undefined],
    ]);
  });

  it('resets step numbering at turn boundaries and after an undo', async () => {
    const s1 = summary('s1', 'reset', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 first', T1),
      stepBeginLine('u1', 1, T1 + 100),
      assistantStepLine('苹果 reply one', 'u1', T1 + 200),
      userLine('苹果 second', T2),
      stepBeginLine('u2', 1, T2 + 100),
      assistantStepLine('苹果 reply two', 'u2', T2 + 200),
      rawRecord({ type: 'context.undo', time: T2 + 300, count: 1 }),
      userLine('苹果 redone', T3),
      stepBeginLine('u3', 1, T3 + 100),
      assistantStepLine('苹果 redone reply', 'u3', T3 + 200),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    // The undone step keeps its pre-undo id (same deviation as turns); the
    // redo renumbers from a fresh tracker.
    expect(page.items.map((h) => h.stepId)).toEqual(['t0.1', 't1.1', 't1.1']);
  });

  it('falls back to counting step.begin records when the wire carries no ordinal', async () => {
    const s1 = summary('s1', 'fallback', T1);
    await writeWire(home!, 's1', 'main', [
      userLine('苹果 question', T1),
      rawRecord({
        type: 'context.append_loop_event',
        time: T1 + 100,
        event: { type: 'step.begin', uuid: 'u1' },
      }),
      assistantStepLine('苹果 reply', 'u1', T1 + 200),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    const page = await service.search({ query: '苹果', role: 'assistant' });
    expect(page.items[0]?.stepId).toBe('t0.1');
  });

  it('keeps step attribution across incremental sync passes', async () => {
    const s1 = summary('s1', 'resume steps', T1);
    // The first pass indexes the turn boundary and the step.begin only; the
    // text arrives later — the uuid → ordinal mapping must survive in the
    // persisted stepState for the next pass to attribute the doc.
    const file = await writeWire(home!, 's1', 'main', [
      userLine('苹果 question', T1),
      stepBeginLine('u1', 1, T1 + 100),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    await appendFile(file, `${assistantStepLine('苹果 reply', 'u1', T2)}\n`, 'utf8');
    await settleSync(service);
    const page = await service.search({ query: '苹果', role: 'assistant' });
    expect(page.items.map((h) => [h.turn, h.stepId])).toEqual([[0, 't0.1']]);
  });

  it('rescans a wire file whose meta predates step tracking', async () => {
    const s1 = summary('s1', 'legacy meta', T1);
    const file = await writeWire(home!, 's1', 'main', [
      userLine('苹果 question', T1),
      stepBeginLine('u1', 1, T1 + 100),
      assistantStepLine('苹果 reply one', 'u1', T1 + 200),
    ]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    // Simulate a file meta written before step tracking existed by stripping
    // stepState from the persisted meta.
    const db = internals(service).db;
    expect(db).not.toBeNull();
    const metaRows = db!.query({ key: { prefix: '\0meta\\file\\' } });
    expect(metaRows.length).toBe(1);
    for (const row of metaRows) {
      const { stepState: _stripped, ...rest } = row.value;
      await db!.set(row.key, rest);
    }

    // Appending triggers a sync; the legacy meta must force a full rescan of
    // the file, so every doc — old and new — ends up with a stepId.
    await appendFile(file, `${assistantStepLine('苹果 reply two', 'u1', T2)}\n`, 'utf8');
    await settleSync(service);
    const page = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    expect(page.items.map((h) => h.stepId)).toEqual(['t0.1', 't0.1']);
  });

  // -- literal mode -------------------------------------------------------------

  describe('literal mode', () => {
    /** Symbol/CJK/emoji-heavy session the terms tokenizer cannot serve. */
    async function literalFixture(): Promise<GlobalSearchService> {
      const s1 = summary('s1', 'literal 会话', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('modern C++ patterns', T1),
        assistantLine('use foo-bar here', T1 + 100),
        userLine('a foo bar without dash', T1 + 200),
        userLine('检查项 **已通过** 审核', T1 + 300),
        userLine('inline math $\\frac{a}{b}$ here', T1 + 400),
        userLine('launch 🚀🎉 today', T1 + 500),
        userLine('짧은 한국어 문구 테스트', T1 + 600),
      ]);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();
      return service;
    }

    it('finds symbol substrings exactly; distractors without the exact substring do not hit', async () => {
      const service = await literalFixture();

      const cpp = await service.search({ query: 'C++', mode: 'literal' });
      expect(cpp.items.length).toBe(1);
      expect(cpp.items[0]?.snippet).toContain('C++');
      expect(cpp.items[0]?.score).toBe(0); // literal hits are unscored
      expect(cpp.incomplete).toBeUndefined();

      // 'foo-bar' must not match the 'foo bar' doc, and vice versa.
      const dashed = await service.search({ query: 'foo-bar', mode: 'literal' });
      expect(dashed.items.length).toBe(1);
      expect(dashed.items[0]?.snippet).toContain('foo-bar');
      const spaced = await service.search({ query: 'foo bar', mode: 'literal' });
      expect(spaced.items.length).toBe(1);
      expect(spaced.items[0]?.snippet).toContain('without dash');

      const passed = await service.search({ query: '**已通过**', mode: 'literal' });
      expect(passed.items.length).toBe(1);
      expect(passed.items[0]?.snippet).toContain('已通过');

      const latex = await service.search({ query: '$\\frac{a}{b}$', mode: 'literal' });
      expect(latex.items.length).toBe(1);
      expect(latex.items[0]?.snippet).toContain('\\frac');

      const korean = await service.search({ query: '한국어 문구', mode: 'literal' });
      expect(korean.items.length).toBe(1);
      expect(korean.items[0]?.snippet).toContain('한국어');
    });

    it('is case-insensitive and orders by time desc regardless of sort', async () => {
      const service = await literalFixture();
      const page = await service.search({ query: 'c++', mode: 'literal' });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.snippet).toContain('C++');

      // Multiple hits: time desc even when sort is left at its default.
      const foo = await service.search({ query: 'foo', mode: 'literal' });
      expect(foo.items.map((h) => h.time)).toEqual([T1 + 200, T1 + 100]);
    });

    it('serves 2-character queries over the 2-gram path, including emoji pairs', async () => {
      const service = await literalFixture();
      const plus = await service.search({ query: '++', mode: 'literal' });
      expect(plus.items.length).toBe(1);
      expect(plus.items[0]?.snippet).toContain('C++');

      const emoji = await service.search({ query: '🚀🎉', mode: 'literal' });
      expect(emoji.items.length).toBe(1);
      expect(emoji.items[0]?.snippet).toContain('🚀🎉');
    });

    it('rejects queries shorter than 2 normalized characters', async () => {
      const service = await literalFixture();
      await expect(service.search({ query: 'c', mode: 'literal' })).rejects.toMatchObject({
        reason: 'invalid_query',
      });
      await expect(service.search({ query: 'c', mode: 'literal' })).rejects.toThrow(
        /literal queries need at least 2 characters/,
      );
      // NFKC can LEGALIZE a 1-character query: the ligature 'ﬀ' folds to 'ff'.
      const ligature = await service.search({ query: 'ﬀ', mode: 'literal' });
      expect(ligature.items).toEqual([]);
      // An untrimmed 2-space query is a legal literal query too.
      const spaces = await service.search({ query: '  ', mode: 'literal' });
      expect(spaces.items).toEqual([]);
    });

    it('flags candidate-cap truncation as incomplete', async () => {
      const s1 = summary('s1', 'capped', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('cap-target one', T1),
        userLine('cap-target two', T1 + 100),
        userLine('cap-target three', T1 + 200),
        userLine('cap-target four', T1 + 300),
      ]);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();
      service.literalCandidateCap = 2;

      const page = await service.search({ query: 'cap-target', mode: 'literal' });
      expect(page.items.length).toBe(2);
      expect(page.incomplete).toBe('candidate_cap');
      // Every returned item is still a confirmed substring hit.
      expect(page.items.every((h) => h.snippet.includes('cap-target'))).toBe(true);

      // terms mode never reports incompleteness.
      const terms = await service.search({ query: 'cap-target' });
      expect(terms.incomplete).toBeUndefined();
    });

    it('paginates and rejects page tokens after a mode change', async () => {
      const s1 = summary('s1', 'paging', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('page-target one', T1),
        userLine('page-target two', T1 + 100),
        userLine('page-target three', T1 + 200),
      ]);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      const page1 = await service.search({ query: 'page-target', mode: 'literal', pageSize: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.hasMore).toBe(true);
      const page2 = await service.search({
        query: 'page-target',
        mode: 'literal',
        pageSize: 2,
        pageToken: page1.pageToken,
      });
      expect(page2.items.length).toBe(1);
      expect(page2.hasMore).toBe(false);
      const times = [...page1.items, ...page2.items].map((h) => h.time);
      expect(new Set(times).size).toBe(3);

      // The token fingerprints the mode: a literal token fails under terms…
      await expect(
        service.search({ query: 'page-target', pageToken: page1.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
      // …and a terms token fails under literal.
      const termsPage = await service.search({ query: 'page-target', pageSize: 2 });
      await expect(
        service.search({ query: 'page-target', mode: 'literal', pageToken: termsPage.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
    });

    it('keeps terms mode untouched when the query contains symbols', async () => {
      const service = await literalFixture();
      // Default mode tokenizes 'C++' to the word 'c' — behavior unchanged.
      const terms = await service.search({ query: 'C++' });
      expect(terms.items.length).toBeGreaterThan(0);
      expect(terms.incomplete).toBeUndefined();
    });
  });

  // -- stage 4: bounded lifecycle ---------------------------------------------

  describe('stage-4 bounded lifecycle', () => {
    it('serves the published generation without waiting for a blocked background sync', async () => {
      const s1 = summary('s1', 'blocked', T1);
      const file = await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
      let block = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const index = makeSessionIndex(async () => {
        if (block) await gate;
        return { items: [s1], nextCursor: undefined };
      });
      const service = track(makeService(home!, index));
      await service.reindex();
      expect((await service.search({ query: '苹果' })).items.length).toBe(1);

      // New bytes arrive, then the next background pass is blocked inside the
      // session enumeration. The search must return promptly with the OLD
      // generation instead of waiting for the pass.
      await appendFile(file, `${userLine('苹果 delta', T2)}\n`, 'utf8');
      block = true;
      const page = await Promise.race([
        service.search({ query: '苹果' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('search waited for the blocked sync')), 2_000),
        ),
      ]);
      expect(page.items.length).toBe(1); // the published generation, not the delta
      expect(page.indexState.stale).toBe(true); // a pass is in flight

      release();
      await settleSync(service);
      const caughtUp = await service.search({ query: '苹果' });
      expect(caughtUp.items.length).toBe(2);
    });

    it('scopes one session sync to its own file-meta keys among 10k sessions', async () => {
      const s1 = summary('s1', 'scoped', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 scoped', T1)]);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      // Seed 10k foreign sessions × 3 file-meta rows directly (no wire files
      // on disk), simulating a large pre-existing index.
      const db = internals(service).db!;
      for (let from = 0; from < 10_000; from += 2_500) {
        const ops: { op: 'set'; key: string; value: unknown }[] = [];
        for (let i = from; i < from + 2_500; i++) {
          for (let j = 0; j < 3; j++) {
            const hash = (i * 3 + j).toString(16).padStart(8, '0').repeat(4);
            ops.push({
              op: 'set',
              key: `\0meta\\file\\fake${i}\\${hash}`,
              value: {
                kind: 'fileMeta',
                sessionId: `fake${i}`,
                agentId: 'main',
                source: 'agents',
                path: `/nonexistent/${i}/${j}`,
                offset: 0,
                size: 0,
              },
            });
          }
        }
        await db.batch(ops);
      }

      // Count the file-meta rows one session sync scans: it must be bounded
      // by THIS session's files, not by the global 30k metas.
      let metaRowsScanned = 0;
      const origQuery = db.query.bind(db);
      db.query = (criteria) => {
        const rows = origQuery(criteria);
        if (criteria.key.prefix.startsWith('\0meta\\file\\')) metaRowsScanned += rows.length;
        return rows;
      };
      await internals(service).syncSession(db, s1);
      expect(metaRowsScanned).toBeLessThanOrEqual(5); // s1 has exactly 1 meta
    });

    it('migrates legacy hash-only file-meta keys to the session-scoped format', async () => {
      const s1 = summary('s1', 'migration', T1);
      const main = await writeWire(home!, 's1', 'main', [userLine('苹果 main', T1)]);
      await writeWire(home!, 's1', 'agent-1', [userLine('苹果 sub', T2)]);
      const first = track(makeService(home!, staticIndex([s1])));
      await first.reindex();
      expect((await first.search({ query: '苹果' })).items.length).toBe(2);

      // Rewrite every file meta under its pre-v2 hash-only key (same value),
      // simulating an index written before the key migration.
      const db = internals(first).db!;
      const metas = db.query({ key: { prefix: '\0meta\\file\\' } });
      expect(metas.length).toBe(2);
      const legacyOffsets = new Map<string, number>();
      for (const row of metas) {
        const path = row.value['path'] as string;
        const legacyKey =
          '\0meta\\file\\' + createHash('sha256').update(path).digest('hex').slice(0, 32);
        legacyOffsets.set(legacyKey, row.value['offset'] as number);
        await db.del(row.key);
        await db.set(legacyKey, row.value);
      }
      first.dispose(); // releases the write lock for the next instance
      await drainGlobalSearchDisposals();

      // A fresh instance migrates on its first background pass.
      const second = track(makeService(home!, staticIndex([s1])));
      await settleSync(second);
      const db2 = internals(second).db!;
      const after = db2.query({ key: { prefix: '\0meta\\file\\' } });
      expect(after.length).toBe(2);
      for (const row of after) {
        // Every key is session-scoped now, and the watermark survived.
        expect(row.key.slice('\0meta\\file\\'.length)).toContain('\\');
        const path = row.value['path'] as string;
        const legacyKey =
          '\0meta\\file\\' + createHash('sha256').update(path).digest('hex').slice(0, 32);
        expect(row.value['offset']).toBe(legacyOffsets.get(legacyKey));
      }

      // The index keeps serving the migrated metas' docs, and an incremental
      // append resumes from the migrated watermark.
      expect((await second.search({ query: '苹果' })).items.length).toBe(2);
      await appendFile(main, `${userLine('苹果 resumed', T3)}\n`, 'utf8');
      await settleSync(second);
      const page = await second.search({ query: '苹果' });
      expect(page.items.length).toBe(3);
      expect(page.items.some((h) => h.snippet.includes('resumed'))).toBe(true);
    });

    it('paginates by keyset without duplicates or gaps under concurrent additive writes', async () => {
      const s1 = summary('s1', 'keyset', T1);
      const lines: string[] = [];
      for (let i = 0; i < 25; i++) lines.push(userLine(`苹果 doc ${i}`, T1 + i));
      const file = await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      const page1 = await service.search({ query: '苹果', sort: 'time_asc', pageSize: 10 });
      expect(page1.items.length).toBe(10);
      expect(page1.hasMore).toBe(true);
      // v2 keyset token: version + generation + boundary.
      const decoded = JSON.parse(
        Buffer.from(page1.pageToken!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(decoded['v']).toBe(2);
      expect(typeof decoded['g']).toBe('number');
      expect(Array.isArray(decoded['b'])).toBe(true);

      // Additive writes land mid-pagination: they do NOT change the
      // generation, and pages stay exact (new docs sort past the cursor).
      const more: string[] = [];
      for (let i = 25; i < 30; i++) more.push(`${userLine(`苹果 doc ${i}`, T1 + i)}\n`);
      await appendFile(file, more.join(''), 'utf8');
      await settleSync(service);

      const page2 = await service.search({
        query: '苹果',
        sort: 'time_asc',
        pageSize: 10,
        pageToken: page1.pageToken,
      });
      const page3 = await service.search({
        query: '苹果',
        sort: 'time_asc',
        pageSize: 10,
        pageToken: page2.pageToken,
      });
      expect(page3.hasMore).toBe(false);

      const times = [...page1.items, ...page2.items, ...page3.items].map((h) => h.time);
      expect(times).toEqual(Array.from({ length: 30 }, (_, i) => T1 + i));
      expect(new Set(times).size).toBe(30);
    });

    it('rejects page tokens from an older generation after a rescan or a reindex', async () => {
      const s1 = summary('s1', 'generation', T1);
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) lines.push(userLine(`苹果 doc ${i} padding`, T1 + i));
      const file = await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      // A shrink rescan REPLACES indexed documents → generation bump.
      const page1 = await service.search({ query: '苹果', sort: 'time_asc', pageSize: 10 });
      await writeFile(
        file,
        `${Array.from({ length: 30 }, (_, i) => userLine('苹果 x', T1 + i)).join('\n')}\n`,
        'utf8',
      );
      await settleSync(service);
      await expect(
        service.search({ query: '苹果', sort: 'time_asc', pageToken: page1.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
      await expect(
        service.search({ query: '苹果', sort: 'time_asc', pageToken: page1.pageToken }),
      ).rejects.toThrow(/older index generation/);

      // A reindex swaps the base → generation bump too.
      const page2 = await service.search({ query: '苹果', sort: 'time_asc', pageSize: 10 });
      await service.reindex();
      await expect(
        service.search({ query: '苹果', sort: 'time_asc', pageToken: page2.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
    });

    it('terminates a hot 2-character literal query within the postings budget', async () => {
      const s1 = summary('s1', 'hot bigram', T1);
      const lines: string[] = [];
      for (let i = 0; i < 400; i++) lines.push(userLine(`的汉 filler ${i} about stuff`, T1 + i));
      await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      // Full budget: the page is complete.
      const full = await service.search({ query: '的汉', mode: 'literal' });
      expect(full.incomplete).toBeUndefined();
      expect(full.items.length).toBe(20);

      // A tiny postings budget stops the index-side candidate scan early and
      // says so — every returned hit is still confirmed, never a false hit.
      service.postingsVisitBudget = 50;
      const page = await service.search({ query: '的汉', mode: 'literal' });
      expect(page.incomplete).toBe('postings_budget');
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((h) => h.snippet.includes('的汉'))).toBe(true);
    });

    it('exposes degraded state when a read-only refresh fails, and recovers', async () => {
      const s1 = summary('s1', 'degraded', T1);
      const file = await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
      const index = staticIndex([s1]);
      const writer = track(makeService(home!, index));
      await writer.reindex();
      const reader = track(makeService(home!, index));
      await reader.status();
      expect((await reader.search({ query: '苹果' })).items.length).toBe(1);

      const original = internals(reader).doRefreshReadonly;
      internals(reader).doRefreshReadonly = async () => {
        throw new Error('refresh boom');
      };
      await appendFile(file, `${userLine('苹果 delta', T2)}\n`, 'utf8');
      await settleSync(writer);

      // The search still serves the stale view; the refresh failure is
      // recorded instead of swallowed.
      const stale = await reader.search({ query: '苹果' });
      expect(stale.items.length).toBe(1);
      await refreshNow(reader);
      const degraded = await reader.search({ query: '苹果' });
      expect(degraded.indexState.state).toBe('readonly');
      expect(degraded.indexState.degraded).toBe('refresh boom');
      expect(degraded.items.length).toBe(1); // still the stale generation

      // Restoring the refresh path self-heals the flag.
      internals(reader).doRefreshReadonly = original;
      await refreshNow(reader);
      const healed = await reader.search({ query: '苹果' });
      expect(healed.indexState.degraded).toBeUndefined();
      expect(healed.items.length).toBe(2);
    });

    it('accepts legacy v1 offset tokens and upgrades them to v2 keyset tokens', async () => {
      const s1 = summary('s1', 'legacy token', T1);
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) lines.push(userLine(`苹果 legacy ${i}`, T1 + i));
      await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      const page1 = await service.search({ query: '苹果', sort: 'time_asc', pageSize: 10 });
      const v2 = JSON.parse(
        Buffer.from(page1.pageToken!, 'base64url').toString('utf8'),
      ) as { v: number; f: string };
      expect(v2.v).toBe(2);

      // Fabricate a pre-versioning offset token with the same fingerprint:
      // it is answered with offset semantics and upgraded on the way out.
      const legacyToken = Buffer.from(JSON.stringify({ f: v2.f, s: 10 })).toString('base64url');
      const page2 = await service.search({
        query: '苹果',
        sort: 'time_asc',
        pageSize: 10,
        pageToken: legacyToken,
      });
      expect(page2.items.map((h) => h.time)).toEqual(
        Array.from({ length: 10 }, (_, i) => T1 + 10 + i),
      );
      expect(page2.hasMore).toBe(true);
      const upgraded = JSON.parse(
        Buffer.from(page2.pageToken!, 'base64url').toString('utf8'),
      ) as { v: number };
      expect(upgraded.v).toBe(2);

      const page3 = await service.search({
        query: '苹果',
        sort: 'time_asc',
        pageSize: 10,
        pageToken: page2.pageToken,
      });
      expect(page3.items.map((h) => h.time)).toEqual(
        Array.from({ length: 10 }, (_, i) => T1 + 20 + i),
      );
      expect(page3.hasMore).toBe(false);
    });

    it('paginates score sort by (score, time, key) without duplicates', async () => {
      const s1 = summary('s1', 'score pages', T1);
      const lines: string[] = [];
      // Varying term frequency per doc produces several score bands.
      for (let i = 0; i < 30; i++) {
        lines.push(userLine(`${'苹果 '.repeat((i % 5) + 1)}doc ${i}`, T1 + i));
      }
      await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      const seen = new Set<number>();
      const boundaryScores: number[] = [];
      let token: string | undefined;
      for (let p = 0; p < 3; p++) {
        const page: Awaited<ReturnType<typeof service.search>> = await service.search({
          query: '苹果',
          sort: 'score',
          pageSize: 10,
          pageToken: token,
        });
        expect(page.items.length).toBe(10);
        for (const hit of page.items) {
          expect(seen.has(hit.time)).toBe(false);
          seen.add(hit.time);
        }
        // Scores are non-increasing within and across pages.
        for (let i = 1; i < page.items.length; i++) {
          expect(page.items[i]!.score).toBeLessThanOrEqual(page.items[i - 1]!.score);
        }
        boundaryScores.push(page.items[0]!.score);
        token = page.pageToken;
      }
      for (let i = 1; i < boundaryScores.length; i++) {
        expect(boundaryScores[i]!).toBeLessThanOrEqual(boundaryScores[i - 1]!);
      }
      expect(seen.size).toBe(30);
      expect(token).toBeUndefined();
    });

    it('self-heals a failed open through search traffic', async () => {
      const s1 = summary('s1', 'heal', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 heal', T1)]);
      const service = track(makeService(home!, staticIndex([s1])));

      // The db open fails transiently (e.g. a read-only open racing a
      // writer's compaction).
      const si = internals(service);
      const origOpen = si.openSearchDb;
      let failOpen = true;
      si.openSearchDb = async () => {
        if (failOpen) throw new Error('open boom');
        return origOpen.call(service);
      };

      // First search: building semantics while the (doomed) pass runs.
      const building = await service.search({ query: '苹果' });
      expect(building.indexState.state).toBe('building');
      await internals(service).syncPromise?.catch(() => {}); // the failing pass

      // While the failure persists, searches surface it — and each kicks a
      // background retry instead of freezing the service.
      await expect(service.search({ query: '苹果' })).rejects.toMatchObject({
        reason: 'index_unavailable',
      });
      await expect(service.search({ query: '苹果' })).rejects.toThrow(/failed to open: open boom/);
      await internals(service).syncPromise?.catch(() => {}); // the kicked retry also fails for now

      // The transient cause goes away. NO explicit sync is driven here: the
      // next search itself must kick the pass that heals the open.
      failOpen = false;
      await expect(service.search({ query: '苹果' })).rejects.toMatchObject({
        reason: 'index_unavailable',
      });
      await internals(service).syncPromise; // the search-kicked pass: succeeds

      const page = await service.search({ query: '苹果' });
      expect(page.items.length).toBe(1);
      expect(page.indexState.state).toBe('ready');
    });

    it('re-serves from the swapped handle when a background refresh lands mid-search', async () => {
      const s1 = summary('s1', 'swap', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 base', T1)]);
      const index = staticIndex([s1]);
      const writer = track(makeService(home!, index));
      await writer.reindex();
      const reader = track(makeService(home!, index));
      await reader.status();
      expect((await reader.search({ query: '苹果' })).items.length).toBe(1);

      // Rotate the writer's WAL so the reader's refresh must take the reopen
      // path (which swaps the handle and closes the previous one).
      await internals(writer).db!.compact();

      // Park the search's fingerprint probe at a gate; while it is parked, a
      // background refresh completes the reopen and closes the handle the
      // search captured.
      const ri = internals(reader);
      const origFp = ri.computeFingerprint.bind(ri);
      let fpCalls = 0;
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      ri.computeFingerprint = async () => {
        fpCalls++;
        if (fpCalls === 1) await probeGate; // the search's probe; the refresh's own probe passes
        return origFp();
      };

      const searchPromise = reader.search({ query: '苹果' });
      for (let i = 0; i < 1_000 && fpCalls === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(fpCalls).toBe(1); // the search is parked inside the probe

      await refreshNow(reader); // reopen + swap + close the captured handle
      releaseProbe();

      // Must re-pin to the swapped handle instead of dying on the closed one.
      const page = await searchPromise;
      expect(page.items.length).toBe(1);
      expect(page.indexState.state).toBe('readonly');
    });

    it('rejects over-budget queries: too many terms, oversized literal', async () => {
      const s1 = summary('s1', 'budget', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 budget', T1)]);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      service.maxQueryTerms = 3;
      await expect(service.search({ query: 'aa bb cc dd' })).rejects.toMatchObject({
        reason: 'invalid_query',
      });
      await expect(service.search({ query: 'aa bb cc dd' })).rejects.toThrow(/too many terms/);
      // Duplicate terms collapse before the count.
      expect((await service.search({ query: 'aa aa bb cc' })).items).toEqual([]);

      const oversized = 'x'.repeat(1_025);
      await expect(service.search({ query: oversized, mode: 'literal' })).rejects.toMatchObject({
        reason: 'invalid_query',
      });
      await expect(service.search({ query: oversized, mode: 'literal' })).rejects.toThrow(
        /limited to 1024 characters/,
      );
    });

    it('flags deadline and text-budget stops as incomplete instead of truncating silently', async () => {
      const s1 = summary('s1', 'deadline', T1);
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) lines.push(userLine(`苹果 deadline ${i}`, T1 + i));
      await writeWire(home!, 's1', 'main', lines);
      const service = track(makeService(home!, staticIndex([s1])));
      await service.reindex();

      // An already-expired deadline stops the match loop immediately.
      service.queryDeadlineMs = -1;
      const stopped = await service.search({ query: '苹果' });
      expect(stopped.incomplete).toBe('deadline');
      expect(stopped.items).toEqual([]);
      service.queryDeadlineMs = 500;
      const complete = await service.search({ query: '苹果' });
      expect(complete.incomplete).toBeUndefined();
      expect(complete.items.length).toBe(20);

      // Literal confirmation charges each candidate's text against the
      // volume budget: two 40-char docs fit a budget of 50, the third stops.
      service.queryTextBudgetChars = 50;
      const textStopped = await service.search({ query: '苹果', mode: 'literal' });
      expect(textStopped.incomplete).toBe('deadline');
      expect(textStopped.items.length).toBeLessThan(20);
      service.queryTextBudgetChars = 16_000_000;
      const textComplete = await service.search({ query: '苹果', mode: 'literal' });
      expect(textComplete.incomplete).toBeUndefined();
    });
  });

  // -- live route (in-memory transcript scan) ------------------------------------

  describe('live route', () => {
    /** Session-index stub whose `get` resolves the fixture summaries. */
    function gettableIndex(summaries: SessionSummary[]): ISessionIndex {
      const byId = new Map(summaries.map((s) => [s.id, s]));
      return {
        _serviceBrand: undefined,
        prepare: async () => ({ state: 'uninitialized', degradedCount: 0 }),
        status: () => ({ state: 'uninitialized', degradedCount: 0 }),
        listRecent: async () => ({ items: summaries, nextCursor: undefined }),
        get: async (id) => byId.get(id),
        count: async () => summaries.length,
        remove: async () => {},
      };
    }

    interface LiveSourceCalls {
      whenReady: string[];
      ensureAgentHistory: [string, string][];
    }

    function fakeLiveSource(
      stores: Map<string, TranscriptStore>,
      calls?: LiveSourceCalls,
    ): LiveTranscriptSource {
      return {
        forSessionLive: (sessionId) => stores.get(sessionId),
        whenReady: async (sessionId) => {
          calls?.whenReady.push(sessionId);
        },
        ensureAgentHistory: async (sessionId, agentId) => {
          calls?.ensureAgentHistory.push([sessionId, agentId]);
        },
      };
    }

    /**
     * A real TranscriptStore mirroring the wire fixture of the parity test:
     * turn 0 with a user prompt at T1 and one assistant text frame in step
     * `t0.1` at T2, plus a thinking frame and a tool frame that must NOT be
     * searchable.
     */
    function makeLiveStore(sessionId: string): TranscriptStore {
      const store = new TranscriptStore(sessionId);
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.getAgent('main')!.apply([
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't0',
            ordinal: 0,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: '帮我看看苹果怎么挑',
            startedAt: new Date(T1).toISOString(),
          },
        },
        {
          op: 'step.upsert',
          turnId: 't0',
          step: {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'completed',
            startedAt: new Date(T2).toISOString(),
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: { kind: 'thinking', frameId: 't0.1.f1', text: '苹果 thinking 不可见' },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'tool',
            frameId: 't0.1.f2',
            toolCallId: 'call-1',
            name: 'Read',
            state: 'done',
          },
        },
        {
          op: 'frame.upsert',
          turnId: 't0',
          stepId: 't0.1',
          frame: {
            kind: 'text',
            frameId: 't0.1.f3',
            role: 'assistant',
            text: '苹果要挑红富士。',
          },
        },
      ]);
      return store;
    }

    /**
     * Generic turn builder for the terms-mode and edge-case tests: one turn
     * (optional prompt, optional state) whose steps carry only assistant text
     * frames.
     */
    function addLiveTurn(
      store: TranscriptStore,
      agentId: string,
      turn: {
        ordinal: number;
        startedAt: number;
        prompt?: string;
        state?: 'running' | 'completed';
        steps?: readonly {
          stepId: string;
          startedAt?: number;
          endedAt?: number;
          state?: 'running' | 'completed';
          texts?: readonly string[];
        }[];
      },
    ): void {
      const turnId = `t${turn.ordinal}`;
      const ops: TranscriptOperation[] = [
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId,
            ordinal: turn.ordinal,
            state: turn.state ?? 'completed',
            origin: { kind: 'user' },
            prompt: turn.prompt,
            startedAt: new Date(turn.startedAt).toISOString(),
          },
        },
      ];
      for (const step of turn.steps ?? []) {
        ops.push({
          op: 'step.upsert',
          turnId,
          step: {
            kind: 'step',
            stepId: step.stepId,
            turnId,
            ordinal: Number(step.stepId.split('.')[1] ?? 0),
            state: step.state ?? 'completed',
            startedAt:
              step.startedAt !== undefined ? new Date(step.startedAt).toISOString() : undefined,
            endedAt: step.endedAt !== undefined ? new Date(step.endedAt).toISOString() : undefined,
          },
        });
        (step.texts ?? []).forEach((text, i) => {
          ops.push({
            op: 'frame.upsert',
            turnId,
            stepId: step.stepId,
            frame: {
              kind: 'text',
              frameId: `${step.stepId}.f${i}`,
              role: 'assistant',
              text,
            },
          });
        });
      }
      store.getAgent(agentId)!.apply(ops);
    }

    it('serves container-scoped literal queries from the live transcript store', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(stores, calls));

      const page = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(page.source).toBe('live');
      // 1 user doc + 1 assistant doc + 1 title doc were scanned.
      expect(page.indexState).toEqual({
        state: 'ready',
        indexedSessions: 1,
        totalSessions: 1,
        documents: 3,
      });
      // Backfill gates ran for the session and its whole roster.
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([['s1', 'main']]);

      const user = page.items.find((h) => h.role === 'user');
      expect(user).toBeDefined();
      expect(user!.sessionId).toBe('s1');
      expect(user!.workspaceId).toBe(WS);
      expect(user!.sessionTitle).toBe('苹果标题');
      expect(user!.agentId).toBe('main');
      expect(user!.turn).toBe(0);
      expect(user!.stepId).toBeUndefined();
      expect(user!.time).toBe(T1);
      expect(user!.snippet).toContain('苹果');

      const assistant = page.items.find((h) => h.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.turn).toBe(0);
      expect(assistant!.stepId).toBe('t0.1');
      expect(assistant!.time).toBe(T2);

      const title = page.items.find((h) => h.role === 'title');
      expect(title).toBeDefined();
      expect(title!.snippet).toBe('苹果标题');

      // Thinking and tool frames are not searchable.
      const thinking = await service.search({
        query: '不可见',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(thinking.items).toEqual([]);
    });

    it('accepts single-character literal queries on the live route', async () => {
      // The <2-character gate is an n-gram index constraint; the live route's
      // in-memory scan has no such limit.
      const s1 = summary('s1', '苹果标题', T1);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', makeLiveStore('s1')]])));

      const page = await service.search({
        query: '苹',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(page.source).toBe('live');
      // user prompt + assistant frame + title all contain '苹'.
      expect(page.items.length).toBe(3);
      expect(page.items.map((h) => h.role).sort()).toEqual(['assistant', 'title', 'user']);

      // The index route keeps rejecting the same 1-character query.
      await expect(service.search({ query: '苹', mode: 'literal' })).rejects.toMatchObject({
        reason: 'invalid_query',
      });
    });

    it('falls back to the index route when no source is wired or the session is not live', async () => {
      const s1 = summary('s1', 'fallback', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 from index', T1)]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();

      // No source wired at all → always the index route.
      const unwired = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(unwired.source).toBe('index');
      expect(unwired.items.length).toBe(1);

      // Source wired but the session is not in memory → still the index route.
      service.setLiveTranscriptSource(fakeLiveSource(new Map()));
      const notLive = await service.search({
        query: '苹果',
        mode: 'literal',
        container: { sessionId: 's1' },
      });
      expect(notLive.source).toBe('index');
      expect(notLive.items.length).toBe(1);
    });

    it('serves terms queries from the live store and orders hits by tf score', async () => {
      const s1 = summary('s1', '无关标题', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '苹果怎么挑' });
      addLiveTurn(store, 'main', { ordinal: 1, startedAt: T2, prompt: '苹果苹果都要' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(2);
      // The doc repeating the term scores higher (Σ log(1 + tf)).
      expect(page.items[0]!.time).toBe(T2);
      expect(page.items[1]!.time).toBe(T1);
      expect(page.items[0]!.score).toBeGreaterThan(page.items[1]!.score);
      expect(page.items[1]!.score).toBeGreaterThan(0);

      // Duplicate query terms collapse to one (same as `TextIndex.search`).
      const dup = await service.search({ query: '苹果 苹果', container: { sessionId: 's1' } });
      expect(dup.items.map((h) => h.time)).toEqual(page.items.map((h) => h.time));
    });

    it('returns matching terms result sets on both routes for equivalent data', async () => {
      const s1 = summary('s1', '无关标题', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('帮我看看苹果怎么挑', T1),
        stepBeginLine('u1', 1, T1 + 100),
        assistantStepLine('苹果要挑红富士。', 'u1', T2),
      ]);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const query = { query: '苹果', container: { sessionId: 's1' } };
      const live = await service.search(query);
      expect(live.source).toBe('live');
      expect(live.items.length).toBe(2);

      stores.delete('s1'); // the same query now falls to the index route
      const index = await service.search(query);
      expect(index.source).toBe('index');
      expect(index.items.length).toBe(2);

      // Scores are not comparable across routes (the live route has no
      // corpus-wide IDF); compare hit identity, plus each route's own
      // score-ordering property.
      const identity = (page: typeof live) =>
        page.items
          .map((h) => ({
            sessionId: h.sessionId,
            agentId: h.agentId,
            role: h.role,
            time: h.time,
            turn: h.turn,
            stepId: h.stepId,
          }))
          .sort((a, b) => a.time - b.time);
      expect(identity(live)).toEqual(identity(index));
      for (const page of [live, index]) {
        for (let i = 1; i < page.items.length; i++) {
          expect(page.items[i - 1]!.score).toBeGreaterThanOrEqual(page.items[i]!.score);
        }
      }
    });

    it('applies role, time, agent and sort filters on the live route', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.ensureAgent('sub', { agentId: 'sub', type: 'sub' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        prompt: '苹果 user question',
        steps: [{ stepId: 't0.1', startedAt: T2, texts: ['苹果 assistant answer'] }],
      });
      addLiveTurn(store, 'sub', { ordinal: 0, startedAt: T3, prompt: '苹果 subagent prompt' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const base = { query: '苹果', container: { sessionId: 's1' } };
      const users = await service.search({ ...base, role: 'user' });
      expect(users.items.length).toBe(2);
      expect(users.items.every((h) => h.role === 'user')).toBe(true);

      const assistants = await service.search({ ...base, role: 'assistant' });
      expect(assistants.items.length).toBe(1);
      expect(assistants.items[0]!.stepId).toBe('t0.1');

      const ranged = await service.search({ ...base, startTime: T2, endTime: T2 });
      expect(ranged.items.length).toBe(1);
      expect(ranged.items[0]!.time).toBe(T2);

      const subOnly = await service.search({
        ...base,
        container: { sessionId: 's1', agentId: 'sub' },
      });
      expect(subOnly.items.length).toBe(1);
      expect(subOnly.items[0]!.agentId).toBe('sub');

      const asc = await service.search({ ...base, sort: 'time_asc' });
      expect(asc.items.map((h) => h.time)).toEqual([T1, T2, T3]);
      const desc = await service.search({ ...base, sort: 'time_desc' });
      expect(desc.items.map((h) => h.time)).toEqual([T3, T2, T1]);
    });

    it('hits the session title doc on the live route (terms mode)', async () => {
      const s1 = summary('s1', '苹果标题', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '随便聊聊' });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(1);
      const hit = page.items[0]!;
      expect(hit.role).toBe('title');
      expect(hit.agentId).toBe('');
      expect(hit.sessionId).toBe('s1');
      expect(hit.snippet).toBe('苹果标题');
    });

    it('scopes container.agentId queries to that agent only', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      store.ensureAgent('sub', { agentId: 'sub', type: 'sub' });
      addLiveTurn(store, 'main', { ordinal: 0, startedAt: T1, prompt: '苹果 from main' });
      addLiveTurn(store, 'sub', { ordinal: 0, startedAt: T2, prompt: '苹果 from sub' });
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]]), calls));

      const page = await service.search({
        query: '苹果',
        container: { sessionId: 's1', agentId: 'sub' },
      });
      expect(page.source).toBe('live');
      // Backfill ran for the requested agent only, and only its docs scanned.
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([['s1', 'sub']]);
      expect(page.indexState.documents).toBe(1);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.agentId).toBe('sub');
    });

    it('handles an empty roster, prompt-less turns and empty text frames', async () => {
      const s1 = summary('s1', '', T1);
      const calls: LiveSourceCalls = { whenReady: [], ensureAgentHistory: [] };
      const service = track(makeService(home!, gettableIndex([s1])));
      const stores = new Map([['s1', new TranscriptStore('s1')]]);
      service.setLiveTranscriptSource(fakeLiveSource(stores, calls));

      // Empty roster: no agents at all — nothing to backfill or scan.
      const empty = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(empty.source).toBe('live');
      expect(empty.items).toEqual([]);
      expect(empty.indexState.documents).toBe(0);
      expect(calls.whenReady).toEqual(['s1']);
      expect(calls.ensureAgentHistory).toEqual([]);

      // A turn without a prompt and steps with empty/whitespace-only text
      // frames produce no documents and do not break the scan.
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        steps: [{ stepId: 't0.1', startedAt: T1, texts: ['', '   '] }],
      });
      addLiveTurn(store, 'main', { ordinal: 1, startedAt: T2, prompt: '苹果 survives' });
      stores.set('s1', store);
      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.role).toBe('user');
      expect(page.indexState.documents).toBe(1);
    });

    it('does not fall back to the index when the live route fails', async () => {
      const s1 = summary('s1', 'boom', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 from index', T1)]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();

      const store = makeLiveStore('s1');
      service.setLiveTranscriptSource({
        forSessionLive: (sessionId) => (sessionId === 's1' ? store : undefined),
        whenReady: async () => {
          throw new Error('backfill boom');
        },
        ensureAgentHistory: async () => {},
      });

      // The index has a hit for this query, but a live-route failure is a
      // real error and must surface instead of falling back.
      await expect(
        service.search({ query: '苹果', container: { sessionId: 's1' } }),
      ).rejects.toThrow('backfill boom');
    });

    it('searches the partial text of an in-flight turn', async () => {
      const s1 = summary('s1', '', T1);
      const store = new TranscriptStore('s1');
      store.ensureAgent('main', { agentId: 'main', type: 'main' });
      addLiveTurn(store, 'main', {
        ordinal: 0,
        startedAt: T1,
        state: 'running',
        prompt: '苹果 running prompt',
        steps: [{ stepId: 't0.1', startedAt: T2, state: 'running', texts: ['苹果 partial answer'] }],
      });
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(new Map([['s1', store]])));

      const page = await service.search({ query: '苹果', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items.length).toBe(2);
      expect(page.items.some((h) => h.role === 'user' && h.snippet.includes('running'))).toBe(true);
      expect(
        page.items.some((h) => h.role === 'assistant' && h.snippet.includes('partial')),
      ).toBe(true);
    });

    it('matches nothing for a query that tokenizes to zero terms', async () => {
      const s1 = summary('s1', '', T1);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const page = await service.search({ query: '+++', container: { sessionId: 's1' } });
      expect(page.source).toBe('live');
      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
    });

    it('rejects page tokens across a route flip (the fingerprint covers the source)', async () => {
      const s1 = summary('s1', 'flip', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('苹果 index one', T1),
        assistantLine('苹果 index two', T2),
      ]);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      // Live route, page 1 of 2 (title 'flip' does not contain the query).
      const query = {
        query: '苹果',
        mode: 'literal' as const,
        container: { sessionId: 's1' },
        pageSize: 1,
      };
      const livePage = await service.search(query);
      expect(livePage.source).toBe('live');
      expect(livePage.hasMore).toBe(true);

      // The session closes mid-pagination: the same query now takes the index
      // route and must reject the live-issued token.
      stores.delete('s1');
      await expect(
        service.search({ ...query, pageToken: livePage.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });

      // And the reverse: an index-issued token fails once the session is live.
      const indexPage = await service.search(query);
      expect(indexPage.source).toBe('index');
      expect(indexPage.hasMore).toBe(true);
      stores.set('s1', makeLiveStore('s1'));
      await expect(
        service.search({ ...query, pageToken: indexPage.pageToken }),
      ).rejects.toMatchObject({ reason: 'invalid_page_token' });
    });

    it('returns identical literal results on both routes for equivalent data', async () => {
      const s1 = summary('s1', '无关标题', T1);
      await writeWire(home!, 's1', 'main', [
        userLine('帮我看看苹果怎么挑', T1),
        stepBeginLine('u1', 1, T1 + 100),
        assistantStepLine('苹果要挑红富士。', 'u1', T2),
      ]);
      const stores = new Map([['s1', makeLiveStore('s1')]]);
      const service = track(makeService(home!, gettableIndex([s1])));
      await service.reindex();
      service.setLiveTranscriptSource(fakeLiveSource(stores));

      const query = { query: '苹果', mode: 'literal' as const, container: { sessionId: 's1' } };
      const live = await service.search(query);
      expect(live.source).toBe('live');

      stores.delete('s1'); // the same query now falls to the index route
      const index = await service.search(query);
      expect(index.source).toBe('index');

      const project = (page: typeof live) =>
        page.items.map((h) => ({
          sessionId: h.sessionId,
          workspaceId: h.workspaceId,
          sessionTitle: h.sessionTitle,
          agentId: h.agentId,
          role: h.role,
          snippet: h.snippet,
          time: h.time,
          turn: h.turn,
          stepId: h.stepId,
          score: h.score,
        }));
      expect(project(live)).toEqual(project(index));
    });
  });

  describe('lifecycle drain correctness (plan 13)', () => {
    it('closes the handle when post-open index setup fails, and the next open becomes the writer again (review #19)', async () => {
      const s1 = summary('s1', 'open failure', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 recovery', T1)]);
      const service = track(makeService(home!, staticIndex([s1])));

      // Inject a failure into the writer-side text-index creation that runs
      // after MiniDb.open has handed out the handle.
      const spy = vi
        .spyOn(MiniDb.prototype, 'createTextIndex')
        .mockRejectedValueOnce(new Error('injected createTextIndex failure'));
      await expect(service.reindex()).rejects.toThrow('injected createTextIndex failure');
      spy.mockRestore();

      // The failed open must not have published the handle, and the handle
      // must be closed — otherwise the leaked writer keeps the lock for the
      // rest of the process lifetime and every later open degrades to
      // read-only (the review #19 self-lock).
      expect(internals(service).db).toBeNull();

      // The very next open takes the write lock again (same process).
      await service.reindex();
      const db = internals(service).db;
      expect(db).not.toBeNull();
      expect((db as unknown as { readOnly: boolean }).readOnly).toBe(false);
      expect((await service.search({ query: '苹果' })).items.length).toBe(1);
    });

    it('dispose drains an in-flight sync before closing the db; the deleteSessionDocs/STATS_KEY windows are gated (review #20)', async () => {
      const s1 = summary('s1', 'drain sync', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 drain', T1)]);
      const { log, warnings } = recordingLog();
      const sessions = [s1];
      const service = new GlobalSearchService(
        makeSessionIndex(async () => ({ items: sessions, nextCursor: undefined })),
        makeBootstrap(home!),
        log,
      );
      service.syncDebounceMs = 0;
      track(service);
      await service.reindex();
      expect((await service.search({ query: '苹果' })).items.length).toBe(1);
      // The search kicked a fire-and-forget pass: settle it, or the syncNow
      // below would single-flight JOIN it instead of starting a gated pass.
      await settleSync(service);

      // Record trailing writes; the gated pass must skip its STATS_KEY write.
      const db = internals(service).db!;
      const setKeys: string[] = [];
      const origSet = db.set.bind(db);
      db.set = async (key: string, value: unknown) => {
        setKeys.push(key);
        return origSet(key, value);
      };

      // The next pass deletes the disappeared session; block it inside the
      // deleteSessionDocs window, then dispose mid-pass.
      sessions.length = 0;
      const blocked = blockFirstCall(service, 'deleteSessionDocs');
      const sync = syncNow(service);
      await blocked.entered;
      service.dispose();

      let drained = false;
      const drain = drainGlobalSearchDisposals().then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false); // the drain waits for the in-flight pass

      blocked.release();
      await sync;
      await drain;
      expect(drained).toBe(true);
      expect(internals(service).db).toBeNull();
      // The gate closed before the trailing stats write: it was skipped, and
      // no background write ever hit the closed handle.
      expect(setKeys).not.toContain('\0meta\\stats');
      expect(warnings.filter((w) => w.includes('closed'))).toEqual([]);
    });

    it('dispose drains an in-flight read-only refresh before closing the db (review #20)', async () => {
      const s1 = summary('s1', 'drain refresh', T1);
      await writeWire(home!, 's1', 'main', [userLine('苹果 refresh', T1)]);
      const writer = track(makeService(home!, staticIndex([s1])));
      await writer.reindex();

      // A second instance on the same home opens read-only (the writer holds
      // the lock) and catches up by refreshing from the writer's commits.
      const { log, warnings } = recordingLog();
      const reader = new GlobalSearchService(staticIndex([s1]), makeBootstrap(home!), log);
      reader.syncDebounceMs = 0;
      track(reader);
      await syncNow(reader); // join the constructor-kicked pass: opens the read-only handle
      expect((internals(reader).db as unknown as { readOnly: boolean } | null)?.readOnly).toBe(true);

      // Block the next refresh inside its fingerprint probe, then dispose.
      const blocked = blockFirstCall(reader, 'computeFingerprint');
      const refresh = refreshNow(reader);
      await blocked.entered;
      reader.dispose();

      let drained = false;
      const drain = drainGlobalSearchDisposals().then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false); // the drain waits for the in-flight refresh

      blocked.release();
      await refresh;
      await drain;
      expect(drained).toBe(true);
      expect(internals(reader).db).toBeNull();
      expect(warnings.filter((w) => w.includes('closed'))).toEqual([]);
    });

    it('drainGlobalSearchDisposals also waits for disposals registered while it was draining (review #21)', async () => {
      // One service per home, each with an in-flight pass blocked inside the
      // deleteSessionDocs window.
      const setupBlockedService = async (root: string) => {
        const s1 = summary('s1', 'drain fixpoint', T1);
        await writeWire(root, 's1', 'main', [userLine('苹果 fixpoint', T1)]);
        const sessions = [s1];
        const service = new GlobalSearchService(
          makeSessionIndex(async () => ({ items: sessions, nextCursor: undefined })),
          makeBootstrap(root),
          noopLog,
        );
        service.syncDebounceMs = 0;
        track(service);
        await service.reindex();
        sessions.length = 0;
        const blocked = blockFirstCall(service, 'deleteSessionDocs');
        const sync = syncNow(service);
        await blocked.entered;
        return { service, blocked, sync };
      };

      const a = await setupBlockedService(home!);
      a.service.dispose();

      let drained = false;
      const drain = drainGlobalSearchDisposals().then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false);

      // A second disposal registers WHILE the drain is awaiting the first.
      const homeB = await mkdtemp(join(tmpdir(), 'kimi-kap-search-drain-'));
      try {
        const b = await setupBlockedService(homeB);
        b.service.dispose();

        // Let the first service finish: a snapshot-only drain (Promise.all
        // over the set at call time) would return here, leaving b behind.
        const aDb = internals(a.service).db!;
        a.blocked.release();
        await a.sync;
        // Join A's in-pending close (close is idempotent and shared) so its
        // disposal has fully settled — only promise microtasks remain below.
        await aDb.close();
        await flush();
        expect(drained).toBe(false);

        b.blocked.release();
        await b.sync;
        await drain;
        expect(drained).toBe(true);
        expect(internals(a.service).db).toBeNull();
        expect(internals(b.service).db).toBeNull();
      } finally {
        await rm(homeB, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// stage-1 performance baseline over a synthetic corpus
// ---------------------------------------------------------------------------
// Numbers are logged as JSON for phase-to-phase comparison; only a loose
// complexity budget is asserted (no tight absolute millisecond thresholds in
// shared CI), so an accidental quadratic regression trips the test anywhere.

describe('baseline: synthetic corpus', () => {
  let home: string | undefined;
  const services: GlobalSearchService[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-search-baseline-'));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await drainGlobalSearchDisposals();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  const TOPICS = ['compaction', 'walrus', 'snapshot', 'recovery', '索引', '持久化'];

  async function writeCorpus(from: number, to: number): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (let i = from; i < to; i++) {
      const id = `s${i}`;
      summaries.push(summary(id, `session ${i} 索引讨论`, T1 + i));
      const lines: string[] = [];
      for (let j = 0; j < 8; j++) {
        lines.push(userLine(`session ${i} message ${j} about ${TOPICS[(i + j) % TOPICS.length]!}`, T1 + i * 100 + j));
        lines.push(assistantLine(`reply ${j} covering ${TOPICS[(i + 2 * j) % TOPICS.length]!}`, T1 + i * 100 + j + 1));
      }
      await writeWire(home!, id, 'main', lines);
    }
    return summaries;
  }

  async function medianMs(fn: () => Promise<unknown>, runs = 5): Promise<number> {
    const times: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[(times.length / 2) | 0]!;
  }

  it('indexing and search latency scale within a linear budget from 100 to 400 sessions', async () => {
    // The stub holds the array by reference, so the second reindex sees the
    // sessions appended after the first measurement.
    const all: SessionSummary[] = [];
    const service = makeService(home!, staticIndex(all));
    services.push(service);

    all.push(...(await writeCorpus(0, 100)));
    const t0 = performance.now();
    await service.reindex();
    const index100 = performance.now() - t0;
    const terms100 = await medianMs(() => service.search({ query: 'compaction' }));
    const literal100 = await medianMs(() => service.search({ query: 'message 3 about', mode: 'literal' }));

    all.push(...(await writeCorpus(100, 400)));
    const t1 = performance.now();
    await service.reindex();
    const index400 = performance.now() - t1;
    const terms400 = await medianMs(() => service.search({ query: 'compaction' }));
    const literal400 = await medianMs(() => service.search({ query: 'message 3 about', mode: 'literal' }));

    // Sanity: the corpus really grew and both modes still hit.
    const hits = await service.search({ query: 'compaction' });
    expect(hits.items.length).toBeGreaterThan(0);
    expect((await service.search({ query: 'message 3 about', mode: 'literal' })).items.length).toBeGreaterThan(0);

    console.log(
      `[baseline] searchService ${JSON.stringify({
        sessions: [100, 400],
        reindexMs: [index100, index400],
        termsMedianMs: [terms100, terms400],
        literalMedianMs: [literal100, literal400],
      })}`,
    );
    // 4x the data must cost well under 10x the time at each step.
    expect(index400).toBeLessThan(index100 * 10 + 2000);
    expect(terms400).toBeLessThan(terms100 * 10 + 100);
    expect(literal400).toBeLessThan(literal100 * 10 + 100);
  }, 120_000);

  it('stage-4: deep keyset pages cost like the first page, with a bounded event-loop pause', async () => {
    const all: SessionSummary[] = [];
    const service = makeService(home!, staticIndex(all));
    services.push(service);
    all.push(...(await writeCorpus(0, 400)));
    await service.reindex();

    const eld: IntervalHistogram = monitorEventLoopDelay();
    eld.enable();
    try {
      // 'message' hits every user doc (400 sessions × 8 = 3200 docs). Walk
      // 10 pages of 20 via keyset tokens, then re-measure the first and the
      // tenth page with the same tokens (static corpus → tokens stay valid).
      const tokens: (string | undefined)[] = [undefined];
      let page = await service.search({ query: 'message', sort: 'time_desc', pageSize: 20 });
      for (let p = 1; p < 10; p++) {
        tokens.push(page.pageToken);
        page = await service.search({
          query: 'message',
          sort: 'time_desc',
          pageSize: 20,
          pageToken: page.pageToken,
        });
      }
      expect(page.items.length).toBe(20);

      const page1Ms = await medianMs(() =>
        service.search({ query: 'message', sort: 'time_desc', pageSize: 20 }),
      );
      const page10Ms = await medianMs(() =>
        service.search({ query: 'message', sort: 'time_desc', pageSize: 20, pageToken: tokens[9] }),
      );
      const literalMs = await medianMs(() =>
        service.search({ query: 'message 3 about', mode: 'literal' }),
      );

      const eldMaxMs = eld.max / 1e6;
      const eldP99Ms = eld.percentile(99) / 1e6;
      console.log(
        `[baseline] stage4 ${JSON.stringify({
          sessions: 400,
          page1MedianMs: page1Ms,
          page10MedianMs: page10Ms,
          literalMedianMs: literalMs,
          eventLoopDelayMs: { p99: eldP99Ms, max: eldMaxMs },
        })}`,
      );
      // Page 10 re-runs the same bounded candidate scan but skips the full
      // re-sort + offset slice of the old implementation: its cost tracks
      // the first page's, not the match count × page depth.
      expect(page10Ms).toBeLessThan(page1Ms * 5 + 50);
      // The whole measurement never hard-blocks the loop for long (the
      // query path is synchronous but bounded; syncs run in the background).
      expect(eldMaxMs).toBeLessThan(500);
    } finally {
      eld.disable();
    }
  }, 120_000);
});
