import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  ISessionIndex,
  ISessionIndexMirror,
} from '@moonshot-ai/agent-core-v2';

import { createKimiHarness, SDKRpcClientV2 } from '#/index';
import type { KimiError } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-list-'));
  tempDirs.push(dir);
  return dir;
}

describe('KimiHarness.listSessions', () => {
  it('rejects whitespace-only workDir with request.work_dir_required', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(harness.listSessions({ workDir: '   ' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists all sessions when no payload is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await harness.createSession({ id: 'ses_harness_all_a', workDir });
      await harness.createSession({ id: 'ses_harness_all_b', workDir: otherWorkDir });

      const sessions = await harness.listSessions();
      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'ses_harness_all_a',
        'ses_harness_all_b',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('lists a session from a workDir containing spaces and non-ASCII characters', async () => {
    const homeDir = await makeTempDir();
    const root = await makeTempDir();
    const workDir = join(root, 'Workspace With Spaces', '项目');
    await mkdir(workDir, { recursive: true });
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_unicode_workdir', workDir });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

  it('resolves relative workDir inputs before filtering', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });
    const originalCwd = process.cwd();

    try {
      process.chdir(workDir);
      const session = await harness.createSession({ id: 'ses_relative_workdir', workDir: '.' });

      const sessions = await harness.listSessions({ workDir: '.' });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      process.chdir(originalCwd);
      await harness.close();
    }
  });

  it('lists persisted sessions after the active Session has been closed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_closed_but_listed', workDir });
      await harness.closeSession(session.id);

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });
});

describe('SDKRpcClientV2.listSessionsPage', () => {
  it('pages through the listing with keyset cursors (read model off)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      for (let i = 0; i < 5; i += 1) {
        const created = await client.createSession({ id: `ses_page_${i}`, workDir });
        await client.closeSession({ sessionId: created.id });
      }

      const page1 = await client.listSessionsPage({ workDir, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items.at(-1)?.id);

      const page2 = await client.listSessionsPage({ workDir, limit: 2, before: page1.nextCursor });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBe(page2.items.at(-1)?.id);

      const page3 = await client.listSessionsPage({ workDir, limit: 2, before: page2.nextCursor });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      const pagedIds = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
      expect(new Set(pagedIds)).toEqual(
        new Set([0, 1, 2, 3, 4].map((i) => `ses_page_${String(i)}`)),
      );
      // Draining pages yields exactly the unpaged listing, in the same order.
      const full = await client.listSessions({ workDir });
      expect(pagedIds).toEqual(full.map((item) => item.id));
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('answers an empty terminal page for an unknown cursor', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_cursor_probe', workDir });
      await client.closeSession({ sessionId: created.id });

      await expect(
        client.listSessionsPage({ workDir, before: 'ses_unknown' }),
      ).resolves.toEqual({ items: [], nextCursor: undefined });
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('drains follow-up pages when the mapping drops entries (read model on)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '1');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      for (let i = 0; i < 3; i += 1) {
        const created = await client.createSession({ id: `ses_drain_${i}`, workDir });
        await client.closeSession({ sessionId: created.id });
      }
      const index = client.engineAccessor.get(ISessionIndex);
      await index.prepare();
      // A summary whose workDir can no longer be resolved (unknown workspace,
      // no cwd) is dropped by the mapping; the page must still fill.
      client.engineAccessor.get(ISessionIndexMirror).record({
        id: 'ses_ghost',
        workspaceId: 'ws_missing',
        createdAt: 1,
        updatedAt: Date.now() + 60_000,
        archived: false,
      });
      await drainSessionIndexMirror();

      const page1 = await client.listSessionsPage({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.items.some((item) => item.id === 'ses_ghost')).toBe(false);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await client.listSessionsPage({ limit: 2, before: page1.nextCursor });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).not.toBe('ses_ghost');
      expect(page2.nextCursor).toBeUndefined();

      const ids = [...page1.items, ...page2.items].map((item) => item.id).toSorted();
      expect(ids).toEqual(['ses_drain_0', 'ses_drain_1', 'ses_drain_2']);
    } finally {
      await client.close();
      // Dispose fired the mirror/query-store async closes; await them before
      // the shared afterEach removes the temp home.
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});

describe('SDKRpcClientV2 search-index separation', () => {
  // The global full-text search database (`<homeDir>/search-index`) belongs
  // to the kap-server search surface. The TUI-side chain (rpc client →
  // klient → `ISessionIndex`) must list, resume and continue sessions without
  // ever opening it — including while the session read model is still
  // preparing.

  it('listSessions / resumeSession never open the global search index (read model off)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_search_sep_off', workDir });
      await client.closeSession({ sessionId: created.id });

      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([created.id]);
      const resumed = await client.resumeSession({ id: created.id });
      expect(resumed.id).toBe(created.id);

      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
      // With the read model off, the session query-store is never opened either.
      expect(existsSync(join(homeDir, 'cache', 'query-store'))).toBe(false);
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('listSessions / resumeSession never open the global search index (read model on)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '1');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_search_sep_on', workDir });
      await client.closeSession({ sessionId: created.id });

      // The read model is still preparing here: the first list kicks the
      // background projection and answers from authoritative metadata, the
      // resume reads the authoritative document — neither waits for, nor
      // opens, any full-text index.
      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([created.id]);
      const resumed = await client.resumeSession({ id: created.id });
      expect(resumed.id).toBe(created.id);

      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);

      // Settle the kicked projection before close so teardown never races it,
      // and prove the read model really did engage (the flag took effect).
      const status = await client.engineAccessor.get(ISessionIndex).prepare();
      expect(status.state).toBe('ready');
      expect(existsSync(join(homeDir, 'cache', 'query-store'))).toBe(true);
      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
    } finally {
      await client.close();
      // Dispose fired the mirror/query-store async closes; await them before
      // the shared afterEach removes the temp home.
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});
