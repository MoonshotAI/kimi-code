import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  createUserEntry,
  MAIN_AGENT_ID,
  memorySessionSpace,
  type AppHandle,
  type SessionSpace,
} from '@moonshot-ai/agent-core';

import {
  createSessionIndex,
  SessionIndexQueryError,
  SessionIndexRef,
  type SessionIndexFace,
  type SessionSummaryPage,
} from '#/features/sessionIndex/index';
import { fsSessionSpace } from '#/host/session-space';

const apps: AppHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function disposeApp(app: AppHandle): Promise<void> {
  const index = apps.indexOf(app);
  if (index >= 0) apps.splice(index, 1);
  await app.disposeAsync();
}

interface SessionIndexEnv {
  readonly app: AppHandle;
  readonly face: SessionIndexFace;
}

async function mountSessionIndex(options: {
  space: SessionSpace;
  dbPath?: string;
  sessionDir?: (sessionId: string) => string;
  now?: () => number;
}): Promise<SessionIndexEnv> {
  const app = createHarness({
    space: options.space,
    features: [
      createSessionIndex({
        dbPath: options.dbPath ?? ':memory:',
        sessionDir: options.sessionDir,
        now: options.now,
      }),
    ],
  });
  apps.push(app);
  await app.ready();
  return { app, face: app.resolve(SessionIndexRef) };
}

function ids(page: SessionSummaryPage): string[] {
  return page.items.map((item) => item.id);
}

describe('sessionIndex live write path', () => {
  it('tracks create, meta updates, prompts, lastTurn and delete through node events', async () => {
    let now = 10_000;
    const { app, face } = await mountSessionIndex({
      space: memorySessionSpace(),
      now: () => now,
    });

    const s1 = await app.open({ sessionId: 's1', title: 'first', metadata: { workspaceId: 'ws-a' } });
    expect(face.get('s1')).toEqual({
      id: 's1',
      workspaceId: 'ws-a',
      cwd: null,
      title: 'first',
      createdAt: 10_000,
      updatedAt: 10_000,
      lastPrompt: null,
      lastTurnId: null,
      lastTurnOutcome: null,
      archived: false,
      archivedAt: null,
    });

    now = 11_000;
    await app.open({ sessionId: 's2' });
    expect(face.get('s2')).toMatchObject({ id: 's2', title: null, workspaceId: null, createdAt: 11_000 });

    now = 20_000;
    await app.updateSession('s1', {
      title: 'renamed',
      metadata: { archived: true, archived_at: '2026-01-02T03:04:05.000Z' },
    });
    expect(face.get('s1')).toMatchObject({
      title: 'renamed',
      workspaceId: 'ws-a',
      archived: true,
      archivedAt: Date.parse('2026-01-02T03:04:05.000Z'),
      createdAt: 10_000,
      updatedAt: 20_000,
    });

    now = 30_000;
    await s1.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'test' });
    const store = s1.stores.get(MAIN_AGENT_ID);
    if (store === undefined) throw new Error('main agent store missing');
    await store.dispatch({
      type: 'message.appended',
      message: createUserEntry({ role: 'user', content: [{ type: 'text', text: 'hello sqlite' }] }),
    });
    expect(face.get('s1')).toMatchObject({ lastPrompt: 'hello sqlite', updatedAt: 30_000 });

    now = 35_000;
    await store.dispatch({
      type: 'message.appended',
      message: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], toolCalls: [] },
        meta: {},
      },
    });
    expect(face.get('s1')).toMatchObject({ lastPrompt: 'hello sqlite', updatedAt: 35_000 });

    now = 40_000;
    await s1.stores.session.dispatch({
      type: 'session.meta_updated',
      meta: { lastTurn: { turnId: 2, outcome: 'done' } },
    });
    expect(face.get('s1')).toMatchObject({ lastTurnId: 2, lastTurnOutcome: 'done', updatedAt: 40_000 });

    now = 45_000;
    s1.node.fire({
      type: 'message.appended',
      agentId: 'sub',
      message: createUserEntry({ role: 'user', content: [{ type: 'text', text: 'subagent prompt' }] }),
    });
    expect(face.get('s1')).toMatchObject({ lastPrompt: 'hello sqlite', updatedAt: 40_000 });

    now = 50_000;
    await app.delete('s1');
    expect(face.get('s1')).toBeUndefined();
    expect(face.get('s2')).toMatchObject({ id: 's2', createdAt: 11_000 });
    expect(face.list().total).toBe(1);
  });

  it('tracks cwd and cold-session meta updates through app.updateSession', async () => {
    let now = 1_000;
    const { app, face } = await mountSessionIndex({
      space: memorySessionSpace(),
      now: () => now,
    });

    await app.open({ sessionId: 's1', title: 'live', metadata: { workspaceId: 'ws-a', cwd: '/work/a' } });
    expect(face.get('s1')).toMatchObject({ cwd: '/work/a' });

    await app.close('s1');
    now = 2_000;
    await app.updateSession('s1', {
      title: 'cold-renamed',
      metadata: { archived: true, archived_at: '2026-01-02T03:04:05.000Z', cwd: '/work/b' },
    });
    expect(face.get('s1')).toMatchObject({
      title: 'cold-renamed',
      archived: true,
      archivedAt: Date.parse('2026-01-02T03:04:05.000Z'),
      cwd: '/work/b',
      updatedAt: 2_000,
    });
  });
});

describe('sessionIndex reconcile', () => {
  it('rebuilds the index from the catalog and backfills facts from session journals', async () => {
    const root = await tempDir('session-index-');
    const spaceRoot = join(root, 'sessions');
    const dbPath = join(root, 'index.db');
    const sessionDir = (sessionId: string): string => join(spaceRoot, sessionId);

    const seedSpace = fsSessionSpace(spaceRoot);
    await seedSpace.create('s0', { title: 'raw', metadata: { workspaceId: 'ws-z' } });

    const appA = createHarness({ space: fsSessionSpace(spaceRoot), features: [] });
    await appA.ready();
    const t0 = Date.now();
    const s1 = await appA.open({ sessionId: 's1', title: 'alpha', metadata: { workspaceId: 'ws-a' } });
    await s1.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'test' });
    const store = s1.stores.get(MAIN_AGENT_ID);
    if (store === undefined) throw new Error('main agent store missing');
    await store.dispatch({
      type: 'message.appended',
      message: createUserEntry({ role: 'user', content: [{ type: 'text', text: 'first prompt' }] }),
    });
    await store.dispatch({
      type: 'message.appended',
      message: createUserEntry({ role: 'user', content: [{ type: 'text', text: 'second prompt' }] }),
    });
    await s1.stores.session.dispatch({
      type: 'session.meta_updated',
      meta: { lastTurn: { turnId: 5, outcome: 'failed' } },
    });
    await appA.open({
      sessionId: 's2',
      title: 'beta',
      metadata: { workspaceId: 'ws-b', archived: true, archived_at: '2026-02-01T00:00:00.000Z' },
    });
    const t1 = Date.now();
    await appA.disposeAsync();

    const { app: appB, face: faceB } = await mountSessionIndex({
      space: fsSessionSpace(spaceRoot),
      dbPath,
      sessionDir,
    });

    const r1 = faceB.get('s1');
    expect(r1).toMatchObject({
      workspaceId: 'ws-a',
      title: 'alpha',
      lastPrompt: 'second prompt',
      lastTurnId: 5,
      lastTurnOutcome: 'failed',
      archived: false,
    });
    expect(r1?.createdAt).toBeGreaterThanOrEqual(t0);
    expect(r1?.createdAt).toBeLessThanOrEqual(r1?.updatedAt ?? 0);
    expect(r1?.updatedAt).toBeLessThanOrEqual(t1);

    expect(faceB.get('s0')).toMatchObject({
      title: 'raw',
      workspaceId: 'ws-z',
      createdAt: 0,
      updatedAt: 0,
      lastPrompt: null,
    });

    const r2 = faceB.get('s2');
    expect(r2).toMatchObject({
      title: 'beta',
      workspaceId: 'ws-b',
      archived: true,
      archivedAt: Date.parse('2026-02-01T00:00:00.000Z'),
    });
    expect(r2?.createdAt).toBeGreaterThanOrEqual(t0);

    await disposeApp(appB);

    const driftSpace = fsSessionSpace(spaceRoot);
    await driftSpace.delete('s2');
    await driftSpace.create('s3', { title: 'gamma' });

    const { face: faceC } = await mountSessionIndex({ space: driftSpace, dbPath, sessionDir });
    expect(faceC.get('s2')).toBeUndefined();
    expect(faceC.get('s3')).toMatchObject({ title: 'gamma', workspaceId: null });
    expect(faceC.get('s1')).toMatchObject({ lastPrompt: 'second prompt', lastTurnId: 5 });
    expect(faceC.get('s1')?.createdAt).toBe(r1?.createdAt);
    expect(faceC.list({ archived: 'all' }).total).toBe(3);
  });
});

describe('sessionIndex query semantics', () => {
  it('pushes filters, sort, pagination and by_workspace grouping down to SQL', async () => {
    let now = 0;
    const { app, face } = await mountSessionIndex({
      space: memorySessionSpace(),
      now: () => now,
    });

    async function seed(opts: {
      id: string;
      workspaceId?: string;
      createdAt: number;
      updatedAt: number;
      prompt?: string;
      promptAt?: number;
      archivedAt?: string;
    }): Promise<void> {
      now = opts.createdAt;
      const session = await app.open({
        sessionId: opts.id,
        title: `title-${opts.id}`,
        metadata: opts.workspaceId === undefined ? undefined : { workspaceId: opts.workspaceId },
      });
      if (opts.prompt !== undefined) {
        now = opts.promptAt ?? opts.updatedAt;
        session.node.fire({
          type: 'message.appended',
          agentId: MAIN_AGENT_ID,
          message: createUserEntry({ role: 'user', content: [{ type: 'text', text: opts.prompt }] }),
        });
      }
      now = opts.updatedAt;
      await app.updateSession(
        opts.id,
        opts.archivedAt === undefined ? {} : { metadata: { archived: true, archived_at: opts.archivedAt } },
      );
    }

    await seed({ id: 's1', workspaceId: 'wa', createdAt: 1000, promptAt: 1500, prompt: 'p1', updatedAt: 9000 });
    await seed({ id: 's2', workspaceId: 'wa', createdAt: 2000, updatedAt: 8000 });
    await seed({
      id: 's3',
      workspaceId: 'wa',
      createdAt: 3000,
      promptAt: 3500,
      prompt: 'p3',
      updatedAt: 7000,
      archivedAt: '2026-03-01T00:00:00.000Z',
    });
    await seed({ id: 's4', workspaceId: 'wb', createdAt: 4000, promptAt: 4500, prompt: 'p4', updatedAt: 6000 });
    await seed({ id: 's5', workspaceId: 'wb', createdAt: 5000, updatedAt: 5000 });
    await seed({ id: 's6', createdAt: 6000, promptAt: 6100, prompt: 'p6', updatedAt: 6200 });
    await seed({ id: 's7', workspaceId: 'wa', createdAt: 6500, promptAt: 6600, prompt: 'p7', updatedAt: 7000 });
    await seed({ id: 's8', workspaceId: 'wa', createdAt: 8000, updatedAt: 8000 });

    expect(ids(face.list())).toEqual(['s1', 's8', 's2', 's7', 's6', 's4', 's5']);
    expect(ids(face.list({ archived: 'all' }))).toEqual(['s1', 's8', 's2', 's7', 's3', 's6', 's4', 's5']);
    expect(ids(face.list({ archived: 'true' }))).toEqual(['s3']);
    expect(ids(face.list({ archived: 'all', sort: 'updated_at_asc' }))).toEqual([
      's5', 's4', 's6', 's3', 's7', 's2', 's8', 's1',
    ]);
    expect(ids(face.list({ archived: 'all', sort: 'created_at_desc' }))).toEqual([
      's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1',
    ]);

    expect(ids(face.list({ archived: 'all', workspaceIds: ['wa'] }))).toEqual(['s1', 's8', 's2', 's7', 's3']);
    expect(ids(face.list({ archived: 'all', workspaceIds: ['wa', 'wb'] }))).toEqual([
      's1', 's8', 's2', 's7', 's3', 's4', 's5',
    ]);
    expect(ids(face.list({ archived: 'all', updatedAfter: 8000 }))).toEqual(['s1', 's8', 's2']);
    expect(ids(face.list({ archived: 'all', updatedBefore: 6000 }))).toEqual(['s4', 's5']);
    expect(ids(face.list({ archived: 'all', updatedAfter: 5000, updatedBefore: 8000 }))).toEqual([
      's8', 's2', 's7', 's3', 's6', 's4', 's5',
    ]);
    expect(ids(face.list({ archived: 'all', hasPrompt: true }))).toEqual(['s1', 's7', 's3', 's6', 's4']);
    expect(ids(face.list({ archived: 'all', hasPrompt: false }))).toEqual(['s8', 's2', 's5']);

    const page1 = face.list({ archived: 'all', pageSize: 3 });
    expect(ids(page1)).toEqual(['s1', 's8', 's2']);
    expect(page1).toMatchObject({ total: 8, hasMore: true });
    expect(page1.nextPageToken).not.toBeNull();
    const page2 = face.list({ archived: 'all', pageSize: 3, pageToken: page1.nextPageToken ?? undefined });
    expect(ids(page2)).toEqual(['s7', 's3', 's6']);
    expect(page2).toMatchObject({ total: 8, hasMore: true });
    const page3 = face.list({ archived: 'all', pageSize: 3, pageToken: page2.nextPageToken ?? undefined });
    expect(ids(page3)).toEqual(['s4', 's5']);
    expect(page3).toMatchObject({ total: 8, hasMore: false, nextPageToken: null });

    const offset2 = face.list({ archived: 'all', pageSize: 3, page: 2 });
    expect(ids(offset2)).toEqual(['s7', 's3', 's6']);
    expect(offset2).toMatchObject({ total: 8, hasMore: true, nextPageToken: null });

    expect(() => face.list({ page: 1, pageToken: page1.nextPageToken ?? 'x' })).toThrow(SessionIndexQueryError);
    expect(() => face.list({ pageToken: 'not-a-token' })).toThrow(SessionIndexQueryError);

    const groups1 = face.listByWorkspace({ archived: 'all', pageSize: 2, groupPageSize: 2 });
    expect(groups1).toMatchObject({ total: 3, hasMore: true });
    expect(groups1.groups.map((group) => group.workspaceId)).toEqual(['wa', null]);
    expect(groups1.groups[0]?.total).toBe(5);
    expect(groups1.groups[0]?.sessions.map((row) => row.id)).toEqual(['s1', 's8']);
    expect(groups1.groups[1]?.total).toBe(1);
    expect(groups1.groups[1]?.sessions.map((row) => row.id)).toEqual(['s6']);

    const groups2 = face.listByWorkspace({
      archived: 'all',
      pageSize: 2,
      groupPageSize: 2,
      pageToken: groups1.nextPageToken ?? undefined,
    });
    expect(groups2).toMatchObject({ total: 3, hasMore: false, nextPageToken: null });
    expect(groups2.groups.map((group) => group.workspaceId)).toEqual(['wb']);
    expect(groups2.groups[0]?.total).toBe(2);
    expect(groups2.groups[0]?.sessions.map((row) => row.id)).toEqual(['s4', 's5']);

    const walked: Array<string | null> = [];
    let token: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = face.listByWorkspace({ archived: 'all', pageSize: 1, pageToken: token });
      walked.push(page.groups[0] === undefined ? null : page.groups[0].workspaceId);
      token = page.nextPageToken ?? undefined;
    }
    expect(walked).toEqual(['wa', null, 'wb']);

    const ascGroups = face.listByWorkspace({ archived: 'all', sort: 'updated_at_asc', groupPageSize: 1 });
    expect(ascGroups.groups.map((group) => group.workspaceId)).toEqual(['wb', null, 'wa']);
    expect(ascGroups.groups[2]?.sessions.map((row) => row.id)).toEqual(['s3']);

    expect(face.listAll({ archived: 'all' }).map((row) => row.id)).toEqual([
      's1', 's8', 's2', 's7', 's3', 's6', 's4', 's5',
    ]);
    expect(face.listAll({ workspaceIds: ['wb'], sort: 'updated_at_asc' }).map((row) => row.id)).toEqual([
      's5', 's4',
    ]);
    expect(face.listAll({ archived: 'all', hasPrompt: false }).map((row) => row.id)).toEqual([
      's8', 's2', 's5',
    ]);
  });
});
