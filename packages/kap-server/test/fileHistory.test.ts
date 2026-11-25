import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2';
import { createGitWorktree } from '@moonshot-ai/testkit/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-file-history-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  return server as RunningServer;
}

interface InjectResponse {
  statusCode: number;
  body: string;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: home } },
    headers: { 'content-type': 'application/json' },
  });
  const envelope = res.json() as Envelope<{ id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`failed to create session: ${res.body}`);
  }
  return envelope.data.id;
}

describe('file history of forked and deleted sessions', () => {
  it('counts a fork in the list of the working directory of its source and forgets it when it is deleted', async () => {
    const r = await boot();
    const docs = r.core.accessor.get(IAtomicDocumentStore);
    const listsWith = async (sessionId: string): Promise<string[]> => {
      const lists: string[] = [];
      for (const list of await docs.list('file-history')) {
        const doc = await docs.get<{ sessions: { id: string }[] }>('file-history', list);
        if (doc?.sessions.some(({ id }) => id === sessionId) === true) lists.push(list);
      }
      return lists;
    };
    const post = async <T>(url: string, payload: unknown): Promise<T> => {
      const res = await appOf(r).inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } });
      const envelope = res.json() as Envelope<T>;
      expect(envelope.code, res.body).toBe(0);
      return envelope.data as T;
    };
    const lab = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-file-history-repo-')));
    try {
      const { main, worktree } = await createGitWorktree({ main: join(lab, 'app'), worktree: join(lab, 'app-fix') });
      const forkOf = async (cwd: string, environment?: { environment_id: string; environment_cwd: string }): Promise<{ id: string; workspace_id: string }> => {
        const source = await post<{ id: string; workspace_id: string }>('/api/v1/sessions', { cwd, ...environment });
        const blobs = join(home, 'sessions', source.workspace_id, source.id, 'agents', 'main', 'file-history');
        await mkdir(blobs, { recursive: true });
        await writeFile(join(blobs, 'blob@v1'), 'before');
        return post(`/api/v1/sessions/${source.id}:fork`, {});
      };
      const inMain = await forkOf(main);
      const inWorktree = await forkOf(worktree);
      const pinnedToMain = await forkOf(main, { environment_id: 'local', environment_cwd: main });

      expect(inWorktree.workspace_id).toBe(inMain.workspace_id);
      expect(await listsWith(inMain.id)).toEqual([inMain.workspace_id]);
      expect(pinnedToMain.workspace_id).toBe(inMain.workspace_id);
      expect(await listsWith(pinnedToMain.id)).toEqual([inMain.workspace_id]);
      expect(await listsWith(inWorktree.id)).toHaveLength(1);
      expect(await listsWith(inWorktree.id)).not.toContain(inMain.workspace_id);

      for (const fork of [inMain, inWorktree, pinnedToMain]) {
        await post(`/api/v1/sessions/${fork.id}:delete`, {});
        expect(await listsWith(fork.id)).toEqual([]);
      }
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });
});

describe('file history routes', () => {
  it('serves empty changes and null content for a live session without history', async () => {
    const r = await boot();
    const sessionId = await createSession(r);

    const changes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_number=1`,
    });
    expect(changes.statusCode).toBe(200);
    expect((changes.json() as Envelope<{ changes: unknown[] }>).data).toEqual({
      changes: [],
      recorded: false,
    });

    const content = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/content?turn_number=1&path=a.txt`,
    });
    expect(content.statusCode).toBe(200);
    expect((content.json() as Envelope<{ content: unknown }>).data).toEqual({ content: null });
  });

  it('rejects a session that is not live', async () => {
    const r = await boot();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/file-history/changes?turn_number=1',
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
    expect(envelope.data).toBeNull();
  });

  it('rejects a malformed turn_number', async () => {
    const r = await boot();
    const sessionId = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_number=abc`,
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
  });

  it('no longer takes the turn number as turn_id', async () => {
    const r = await boot();
    const sessionId = await createSession(r);
    for (const url of [
      `/api/v1/sessions/${sessionId}/file-history/changes?turn_id=1`,
      `/api/v1/sessions/${sessionId}/file-history/content?turn_id=1&path=a.txt`,
    ]) {
      const res = await appOf(r).inject({ method: 'GET', url });
      expect((res.json() as Envelope).code).toBe(40001);
    }
  });

  it('requires the turn number', async () => {
    const r = await boot();
    const sessionId = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes`,
    });
    expect((res.json() as Envelope).code).toBe(40001);
  });
});
