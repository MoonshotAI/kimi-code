import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  IBootstrapService,
  ILogService,
  ISessionIndex,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GlobalSearchError,
  GlobalSearchService,
  drainGlobalSearchDisposals,
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
    sessionDir: (ws: string, sid: string) => join(home, 'sessions', ws, sid),
  } as unknown as IBootstrapService;
}

function makeSessionIndex(list: ISessionIndex['list']): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list,
    get: async () => undefined,
    countActive: async () => 0,
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

  it('picks up appended wire lines on the next search', async () => {
    const s1 = summary('s1', 'incremental', T1);
    const file = await writeWire(home!, 's1', 'main', [userLine('苹果 initial', T1)]);
    const service = track(makeService(home!, staticIndex([s1])));
    await service.reindex();

    await appendFile(file, `${userLine('苹果 appended', T2)}\n`, 'utf8');
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
    expect((await service.search({ query: 'partial' })).items).toEqual([]);

    // Once the line is completed, the next pass picks it up.
    await appendFile(file, '\n', 'utf8');
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

    // The writer indexes a new line; the reader must see it via the
    // fingerprint check + catchUpFromWal incremental replay (no full reopen).
    await appendFile(file, `${userLine('苹果 delta', T2)}\n`, 'utf8');
    await writer.search({ query: '苹果' }); // writer-side incremental sync
    const caughtUp = await reader.search({ query: '苹果' });
    expect(caughtUp.items.length).toBe(2);
    expect(caughtUp.items.some((h) => h.snippet.includes('delta'))).toBe(true);

    // WAL rotation on the writer forces the reader's full-reopen fallback;
    // results stay correct afterwards.
    const writerDb = (writer as unknown as { db: { compact(): Promise<void> } | null }).db;
    await writerDb?.compact();
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
    const db = (
      service as unknown as {
        db: {
          query(criteria: {
            key: { prefix: string };
          }): { key: string; value: Record<string, unknown> }[];
          set(key: string, value: unknown): Promise<void>;
        } | null;
      }
    ).db;
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
    const page = await service.search({ query: '苹果', role: 'assistant', sort: 'time_asc' });
    expect(page.items.map((h) => h.stepId)).toEqual(['t0.1', 't0.1']);
  });
});
