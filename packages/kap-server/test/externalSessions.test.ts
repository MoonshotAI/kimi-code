import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface ExternalSessionItem {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly source: string | null;
  readonly last_prompt: string | null;
  readonly last_turn_reason: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly active: boolean;
  readonly live_here: boolean;
  readonly process: string;
  readonly pid: number;
  readonly started_at: string | null;
  readonly stopped_at: string | null;
}

interface ExternalSessionsEnvelope {
  readonly code: number;
  readonly data: { readonly items: ExternalSessionItem[] };
}

interface RuntimeRecordFixture {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly pid: number;
  readonly process: 'server' | 'cli' | 'cli-print';
  readonly startedAt: number;
  readonly ts: number;
  readonly stoppedAt?: number;
}

const OTHER_PID = 99_999_999;

function runtimeRecord(patch: Partial<RuntimeRecordFixture>): RuntimeRecordFixture {
  return {
    sessionId: 'session_a',
    workspaceId: 'wd_a',
    pid: OTHER_PID,
    process: 'cli-print',
    startedAt: 1_000,
    ts: 1_000,
    ...patch,
  };
}

describe('server-v2 /api/v1/external-sessions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-external-sessions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  async function writeRuntimeRecord(record: RuntimeRecordFixture): Promise<void> {
    const dir = join(home!, 'sessions', '.runtime');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${record.sessionId}.json`), JSON.stringify(record));
  }

  async function writeStateMeta(
    workspaceId: string,
    sessionId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(home!, 'sessions', workspaceId, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  async function getItems(): Promise<ExternalSessionItem[]> {
    const res = await authedFetch(server!, base, '/api/v1/external-sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExternalSessionsEnvelope;
    expect(body.code).toBe(0);
    return body.data.items;
  }

  it('returns an empty list when no runtime records exist', async () => {
    expect(await getItems()).toEqual([]);
  });

  it('projects active cli-print records with state.json metadata and null fallbacks', async () => {
    const now = Date.now();
    await writeRuntimeRecord(runtimeRecord({ sessionId: 'session_ext', ts: now, startedAt: now - 30_000 }));
    await writeStateMeta('wd_a', 'session_ext', {
      id: 'session_ext',
      title: 'Delegated task',
      cwd: '/workspace/project',
      custom: { source: 'external-agent' },
      lastPrompt: 'write a file',
      lastTurnReason: 'completed',
      createdAt: now - 31_000,
      updatedAt: now - 1_000,
      archived: false,
    });

    const items = await getItems();
    const item = items.find((entry) => entry.session_id === 'session_ext');
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      workspace_id: 'wd_a',
      title: 'Delegated task',
      cwd: '/workspace/project',
      source: 'external-agent',
      last_prompt: 'write a file',
      last_turn_reason: 'completed',
      active: true,
      live_here: false,
      process: 'cli-print',
      pid: OTHER_PID,
      stopped_at: null,
    });
    expect(item?.created_at).toBe(new Date(now - 31_000).toISOString());
    expect(item?.updated_at).toBe(new Date(now - 1_000).toISOString());
    expect(item?.started_at).toBe(new Date(now - 30_000).toISOString());
  });

  it('keeps recently stopped records with active false and a stopped_at timestamp', async () => {
    const now = Date.now();
    await writeRuntimeRecord(
      runtimeRecord({ sessionId: 'session_done', ts: now - 10_000, stoppedAt: now - 10_000 }),
    );
    await writeStateMeta('wd_a', 'session_done', {
      id: 'session_done',
      createdAt: now - 60_000,
      updatedAt: now - 10_000,
      archived: false,
    });

    const items = await getItems();
    const item = items.find((entry) => entry.session_id === 'session_done');
    expect(item).toBeDefined();
    expect(item?.active).toBe(false);
    expect(item?.stopped_at).toBe(new Date(now - 10_000).toISOString());
    expect(item?.title).toBeNull();
    expect(item?.cwd).toBeNull();
    expect(item?.source).toBeNull();
    expect(item?.last_prompt).toBeNull();
    expect(item?.last_turn_reason).toBeNull();
  });

  it('excludes server-process records, stale crashes, and old stops; prunes 7-day-old files', async () => {
    const now = Date.now();
    await writeRuntimeRecord(
      runtimeRecord({ sessionId: 'session_srv', process: 'server', ts: now }),
    );
    await writeRuntimeRecord(
      runtimeRecord({ sessionId: 'session_crash', ts: now - 30_000 }),
    );
    await writeRuntimeRecord(
      runtimeRecord({
        sessionId: 'session_old_stop',
        ts: now - 49 * 3_600_000,
        stoppedAt: now - 49 * 3_600_000,
      }),
    );
    await writeRuntimeRecord(
      runtimeRecord({
        sessionId: 'session_ancient',
        ts: now - 8 * 86_400_000,
        stoppedAt: now - 8 * 86_400_000,
      }),
    );

    const items = await getItems();
    const ids = items.map((entry) => entry.session_id);
    expect(ids).not.toContain('session_srv');
    expect(ids).not.toContain('session_crash');
    expect(ids).not.toContain('session_old_stop');
    expect(ids).not.toContain('session_ancient');

    const ancient = await readFile(
      join(home!, 'sessions', '.runtime', 'session_ancient.json'),
      'utf8',
    ).catch(() => undefined);
    expect(ancient).toBeUndefined();
  });

  it('marks sessions materialized in this server as live_here', async () => {
    const now = Date.now();
    const created = await authedFetch(server!, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      readonly data: { readonly id: string; readonly workspace_id: string };
    };
    const sessionId = createdBody.data.id;
    await writeRuntimeRecord(
      runtimeRecord({
        sessionId,
        workspaceId: createdBody.data.workspace_id,
        pid: process.pid,
        process: 'cli',
        ts: now,
      }),
    );

    const items = await getItems();
    const item = items.find((entry) => entry.session_id === sessionId);
    expect(item).toBeDefined();
    expect(item?.live_here).toBe(true);
    expect(item?.active).toBe(true);
  });
});
