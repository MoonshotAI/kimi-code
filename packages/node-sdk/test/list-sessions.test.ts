import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createGitWorktree, type GitWorktreeLayout } from '@moonshot-ai/testkit/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionManager,
  IProjectService,
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

async function repository(): Promise<GitWorktreeLayout> {
  const base = await makeTempDir();
  return createGitWorktree({ main: join(base, 'app'), worktree: join(base, 'app-fix') });
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

  it('finds implicit sessions registered with a non-normalized root spelling', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const legacyWorkDir = `${workDir}/.`;
      const workspace = await client.engineAccessor
        .get(IProjectService)
        .resolveImplicit(legacyWorkDir);
      await client.engineAccessor.get(ISessionManager).create({
        workspaceId: workspace.id,
        workDir: legacyWorkDir,
        sessionId: 'ses_non_normalized_root',
      });

      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual(['ses_non_normalized_root']);
    } finally {
      await client.close();
    }
  });

  it('lists a directory\'s sessions from its implicit project only, never from a managed project rooted or registered there', async () => {
    const homeDir = await makeTempDir();
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const dirC = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const registry = client.engineAccessor.get(IProjectService);
      const projectM = await registry.create({ root: dirA, additionalDirs: [dirB], name: 'M' });
      const projectN = await registry.create({ root: dirC, additionalDirs: [dirA], name: 'N' });
      const sessionManager = client.engineAccessor.get(ISessionManager);
      await sessionManager.create({ workspaceId: projectM.id, workDir: dirA, sessionId: 'ses_m' });
      await sessionManager.create({ workspaceId: projectN.id, workDir: dirC, sessionId: 'ses_n' });
      await client.createSession({ id: 'ses_hash_a', workDir: dirA });

      expect((await client.listSessions({ workDir: dirA })).map((item) => item.id)).toEqual(['ses_hash_a']);
      expect(await client.listSessions({ workDir: dirB })).toEqual([]);
      expect(await client.listSessions({ workDir: dirC })).toEqual([]);
      const continued = await client.listSessionsPage({ workDir: dirA, limit: 1 });
      expect(continued.items.map((item) => item.id)).toEqual(['ses_hash_a']);
    } finally {
      await client.close();
    }
  });

  it('finds a session of any project by id, managed projects included, at its own working directory', async () => {
    const homeDir = await makeTempDir();
    const managedRoot = await makeTempDir();
    const elsewhere = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const managed = await client.engineAccessor
        .get(IProjectService)
        .create({ root: managedRoot, additionalDirs: [], name: 'Managed' });
      await client.engineAccessor
        .get(ISessionManager)
        .create({ workspaceId: managed.id, workDir: managedRoot, sessionId: 'ses_managed' });
      await client.createSession({ id: 'ses_elsewhere', workDir: elsewhere });

      const [found] = await client.listSessions({ sessionId: 'ses_managed' });

      expect(found).toMatchObject({ id: 'ses_managed', workDir: managedRoot });
      expect(await client.listSessions({ workDir: managedRoot })).toEqual([]);
      expect(await client.listSessions({ workDir: elsewhere, sessionId: 'ses_managed' })).toEqual([found]);
      expect(await client.listSessionsPage({ workDir: elsewhere, sessionId: 'ses_managed', limit: 1 })).toEqual({ items: [found] });
    } finally {
      await client.close();
    }
  });

  it('keeps finding the sessions of a worktree by its path after the worktree was removed', async () => {
    const homeDir = await makeTempDir();
    const { main, worktree } = await repository();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      await client.createSession({ id: 'ses_main', workDir: main });
      const created = await client.createSession({ id: 'ses_worktree', workDir: worktree });
      await client.closeSession({ sessionId: created.id });
      await rm(worktree, { recursive: true });

      const projects = await client.engineAccessor.get(IProjectService).list();
      expect((await client.listSessions({ workDir: worktree })).map((item) => [item.id, item.workDir])).toEqual([
        ['ses_worktree', worktree],
      ]);
      expect((await client.listSessionsPage({ workDir: worktree, limit: 1 })).items.map((item) => item.id)).toEqual(['ses_worktree']);
      expect((await client.listSessions({ workDir: main })).map((item) => item.id)).toEqual(['ses_main']);
      const fork = await client.forkSession({ id: 'ses_worktree' });
      expect((await client.listSessions({ workDir: worktree })).map((item) => item.id).toSorted()).toEqual(
        ['ses_worktree', fork.id].toSorted(),
      );
      expect(await client.engineAccessor.get(IProjectService).list()).toEqual(projects);
    } finally {
      await client.close();
    }
  });

  it('follows a changed primary for the sessions at the root of a managed project and keeps the others in place', async () => {
    const homeDir = await makeTempDir();
    const { main, worktree } = await repository();
    const moved = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const workspaces = client.engineAccessor.get(IProjectService);
      const sessionManager = client.engineAccessor.get(ISessionManager);
      const { id: workspaceId } = await workspaces.create({ root: main, additionalDirs: [moved], name: 'Managed' });
      await sessionManager.create({ workspaceId, workDir: main, sessionId: 'ses_root' });
      await sessionManager.create({ workspaceId, workDir: worktree, sessionId: 'ses_worktree' });

      await workspaces.setPrimary(workspaceId, moved);

      const workDirOf = async (sessionId: string) => (await client.listSessions({ sessionId }))[0]?.workDir;
      expect(await workDirOf('ses_root')).toBe(moved);
      expect(await workDirOf('ses_worktree')).toBe(worktree);
    } finally {
      await client.close();
    }
  });

  it('continues the newest session of the working directory, keeping a repository and its worktree apart', async () => {
    const homeDir = await makeTempDir();
    const { main, worktree } = await repository();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      await client.createSession({ id: 'ses_main', workDir: main });
      await client.createSession({ id: 'ses_worktree', workDir: worktree });
      await client.createSession({ id: 'ses_worktree_newer', workDir: worktree });

      const fromMain = await client.listSessionsPage({ workDir: main, limit: 1 });
      const fromWorktree = await client.listSessionsPage({ workDir: worktree, limit: 1 });

      expect(fromMain.items.map((item) => [item.id, item.workDir])).toEqual([['ses_main', main]]);
      expect(fromWorktree.items.map((item) => [item.id, item.workDir])).toEqual([
        ['ses_worktree_newer', worktree],
      ]);
      expect((await client.listSessions({ workDir: worktree })).map((item) => item.id)).toEqual([
        'ses_worktree_newer',
        'ses_worktree',
      ]);
    } finally {
      await client.close();
    }
  });

  it('lists all sessions across a project with scope "project" and reports projectWorkDir', async () => {
    const homeDir = await makeTempDir();
    const base = await realpath(await makeTempDir());
    const { main, worktree } = await createGitWorktree({
      main: join(base, 'app'),
      worktree: join(base, 'app-fix'),
    });
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const mainSession = await harness.createSession({ id: 'ses_project_main', workDir: main });
      const wtSession = await harness.createSession({ id: 'ses_project_wt', workDir: worktree });
      expect(mainSession.summary?.projectWorkDir).toBe(main);
      expect(wtSession.summary?.projectWorkDir).toBe(main);

      expect((await harness.listSessions({ workDir: worktree })).map((item) => item.id)).toEqual(['ses_project_wt']);
      expect((await harness.listSessions({ workDir: main })).map((item) => item.id)).toEqual(['ses_project_main']);

      const fromWorktree = await harness.listSessions({ workDir: worktree, scope: 'project' });
      const fromMain = await harness.listSessions({ workDir: main, scope: 'project' });
      const expected = [
        { id: 'ses_project_main', projectWorkDir: main },
        { id: 'ses_project_wt', projectWorkDir: main },
      ];
      expect(
        fromWorktree.map(({ id, projectWorkDir }) => ({ id, projectWorkDir })).toSorted((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(expected);
      expect(
        fromMain.map(({ id, projectWorkDir }) => ({ id, projectWorkDir })).toSorted((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(expected);
    } finally {
      await harness.close();
    }
  });

  it('resolves projectWorkDir for sessions stored under an older implicit workspace alias ID', async () => {
    const homeDir = await makeTempDir();
    const workDir = await realpath(await makeTempDir());
    const legacyId = 'wd_proj_deadbeef0002';
    const setupClient = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const canonical = await setupClient.engineAccessor.get(IProjectService).resolveImplicit(workDir);
    await setupClient.close();
    const entry = {
      root: workDir,
      name: 'proj',
      kind: 'implicit',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(
      join(homeDir, 'projects.json'),
      JSON.stringify({
        schema_version: 2,
        projects: { [legacyId]: entry, [canonical.id]: entry },
        deleted_project_ids: [],
      }),
    );

    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      await client.engineAccessor.get(ISessionManager).create({
        workspaceId: legacyId,
        workDir,
        sessionId: 'ses_legacy_alias',
      });

      const byProject = await client.listSessions({ workDir, scope: 'project' });
      expect(byProject).toEqual([
        expect.objectContaining({ id: 'ses_legacy_alias', projectWorkDir: workDir }),
      ]);

      const globalList = await client.listSessions({});
      expect(globalList).toEqual([
        expect.objectContaining({ id: 'ses_legacy_alias', projectWorkDir: workDir }),
      ]);
    } finally {
      await client.close();
    }
  });

  it('rejects scope without workDir instead of returning global sessions', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      await expect(
        client.listSessionsPage({ scope: 'project' } as never),
      ).rejects.toMatchObject({ code: 'request.work_dir_required' });
    } finally {
      await client.close();
    }
  });
});

describe('SDKRpcClientV2.listSessionsPage', () => {
  it('pages through the listing with keyset cursors (read model off)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', '0');
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
      const full = await client.listSessions({ workDir });
      expect(pagedIds).toEqual(full.map((item) => item.id));
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('answers an empty terminal page for an unknown cursor', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', '0');
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
    vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', '1');
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
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});

describe('SDKRpcClientV2 search-index separation', () => {
  it('listSessions / resumeSession never open the global search index (read model off)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', '0');
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
      expect(existsSync(join(homeDir, 'cache', 'query-store'))).toBe(false);
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('listSessions / resumeSession never open the global search index (read model on)', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', '1');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_search_sep_on', workDir });
      await client.closeSession({ sessionId: created.id });

      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([created.id]);
      const resumed = await client.resumeSession({ id: created.id });
      expect(resumed.id).toBe(created.id);

      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);

      const status = await client.engineAccessor.get(ISessionIndex).prepare();
      expect(status.state).toBe('ready');
      expect(existsSync(join(homeDir, 'cache', 'query-store'))).toBe(true);
      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
    } finally {
      await client.close();
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});
