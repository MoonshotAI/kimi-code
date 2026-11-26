import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import type { Session } from '../src/protocol/session';
import { commit, git } from './helpers/gitRepo';
import { useWorktreeServer } from './helpers/worktreeServer';

interface WorktreeWire {
  path: string;
  name: string;
  repo_root: string;
  workspace_id?: string;
  workspace_name?: string;
  branch?: string;
  origin: 'product' | 'external';
  size_bytes?: number;
  sessions: { id: string; title: string; archived: boolean; busy: boolean }[];
}

interface Deletion {
  deleted: boolean;
  worktree?: { outcome: string; output?: string };
}

describe('server-v2 worktree inventory', () => {
  const fixture = useWorktreeServer('worktree-inventory');
  const { post, get, createRepo, addRemote, project, settledWorktree, forceRunning, stored, sessionEvents } =
    fixture;

  async function listWorktrees(query = ''): Promise<{ items: WorktreeWire[]; total_size_bytes?: number }> {
    const listed = await get<{ items: WorktreeWire[]; total_size_bytes?: number }>(`/worktrees${query}`);
    expect(listed.code).toBe(0);
    return listed.data;
  }

  function worktreeCount(root: string): number {
    return git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length ?? 0;
  }

  it('lists product and external worktrees with their sessions and sizes', async () => {
    const { root, workspaceId } = await project('inventory');
    const session = await settledWorktree(workspaceId);
    const path = session.worktree!.path!;
    const external = join(fixture.scratch, 'inventory-external');
    git(root, 'worktree', 'add', '-q', '-b', 'manual', external);
    const fork = await post<Session>(`/sessions/${session.id}:fork`, { title: 'forked' });
    expect(fork.data.cwd).toBe(path);
    expect(fork.data.worktree?.path).toBe(path);
    await post(`/sessions/${fork.data.id}:archive`);

    const listed = await listWorktrees('?refresh=sizes');
    const mine = listed.items.filter((item) => item.repo_root === root);

    expect(mine.map((item) => [item.path, item.origin])).toEqual(
      [
        [external, 'external'],
        [path, 'product'],
      ].toSorted(([a], [b]) => a!.localeCompare(b!)),
    );
    expect(listed.items.some((item) => item.path === root)).toBe(false);
    const product = mine.find((item) => item.path === path)!;
    expect(product).toMatchObject({
      name: session.worktree!.branch!.slice('kimi/'.length),
      repo_root: root,
      workspace_id: workspaceId,
      workspace_name: 'inventory',
      branch: session.worktree!.branch,
    });
    expect(product.size_bytes).toBeGreaterThan(0);
    expect(product.sessions.toSorted((a, b) => a.title.localeCompare(b.title))).toEqual([
      { id: session.id, title: '', archived: false, busy: false },
      { id: fork.data.id, title: 'forked', archived: true, busy: false },
    ]);
    expect(mine.find((item) => item.path === external)).toMatchObject({
      name: 'inventory-external',
      branch: 'manual',
      workspace_id: workspaceId,
      sessions: [],
    });
    expect(listed.total_size_bytes).toBe(
      listed.items.reduce((total, item) => total + (item.size_bytes ?? 0), 0),
    );
    const cached = await listWorktrees();
    expect(cached.items.find((item) => item.path === path)?.size_bytes).toBe(product.size_bytes);

    git(path, 'branch', '-m', 'renamed-by-agent');
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2_001);
    onTestFinished(() => {
      clock.mockRestore();
    });
    expect((await get<Session>(`/sessions/${session.id}`)).data.worktree?.branch).toBe('renamed-by-agent');
    await expect.poll(async () => (await stored(session.id))?.branch).toBe('renamed-by-agent');
    expect((await listWorktrees()).items.find((item) => item.path === path)?.branch).toBe(
      'renamed-by-agent',
    );
  });

  it('reports what removing a worktree would lose', async () => {
    const { root, workspaceId } = await project('inspect');
    addRemote(root);
    const session = await settledWorktree(workspaceId);
    const path = session.worktree!.path!;
    await writeFile(join(path, 'README.md'), 'changed\n');
    await mkdir(join(path, 'new-dir'));
    await writeFile(join(path, 'new-dir', 'a.txt'), 'a\n');
    await writeFile(join(path, 'new-dir', 'b.txt'), 'b\n');
    await writeFile(join(path, 'committed.txt'), 'c\n');
    git(path, 'add', 'committed.txt');
    commit(path, 'local only');
    const nowhere = join(fixture.scratch, 'nowhere');

    const inspected = await post<{
      items: { path: string; branch?: string; uncommitted_files: number; unpushed_commits: number; sessions: { id: string }[] }[];
      errors: Record<string, { code: number; msg: string }>;
    }>('/worktrees:inspect', { paths: [path, root, nowhere] });

    expect(inspected.code).toBe(0);
    expect(inspected.data.items).toEqual([
      {
        path,
        branch: session.worktree!.branch,
        uncommitted_files: 3,
        unpushed_commits: 1,
        sessions: [{ id: session.id, title: '', archived: false, busy: false }],
      },
    ]);
    expect(inspected.data.errors[root]?.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
    expect(inspected.data.errors[nowhere]?.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
  });

  it('removes a dirty worktree unless a session using it is busy', async () => {
    const { root, workspaceId } = await project('remove');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await writeFile(join(path, 'dirty.txt'), 'x\n');

    const notWorktree = await post('/worktrees:remove', { path: root });
    expect(notWorktree.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);

    const other = await post<Session>(`/sessions/${session.id}:fork`, {});
    await forceRunning(other.data.id, session.worktree!.setup);
    const busy = await post('/worktrees:remove', { path });
    expect(busy.code).toBe(ErrorCode.WORKTREE_REMOVE_FAILED);
    expect(busy.details).toMatchObject({ reason: 'session_busy' });
    expect(existsSync(path)).toBe(true);
    expect((await listWorktrees()).items.find((item) => item.path === path)?.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: other.data.id, busy: true })]),
    );
    await post(`/sessions/${other.data.id}:delete`);

    const events = await sessionEvents();
    const removed = await post<{ removed: boolean; branch_deleted: boolean }>('/worktrees:remove', {
      path,
      delete_branch: true,
    });

    expect(removed.code).toBe(0);
    expect(removed.data).toEqual({ removed: true, branch_deleted: true });
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'branch', '--list', branch)).toBe('');
    expect(worktreeCount(root)).toBe(1);
    expect((await listWorktrees()).items.some((item) => item.path === path)).toBe(false);
    const after = await get<Session>(`/sessions/${session.id}`);
    expect(after.data.worktree).toMatchObject({ path, missing: true, branch_missing: true });
    await expect
      .poll(() => events.find((event) => event.session.id === session.id)?.session.worktree?.missing)
      .toBe(true);
    const status = await post(`/sessions/${session.id}/fs:git_status`, {});
    expect(status.code).toBe(ErrorCode.FS_DIRECTORY_NOT_FOUND);
    const again = await post('/worktrees:remove', { path });
    expect(again.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
  });

  it('prunes a worktree whose directory is already gone and keeps the branch by default', async () => {
    const { root, workspaceId } = await project('remove-gone');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await rm(path, { recursive: true, force: true });
    expect((await listWorktrees()).items.some((item) => item.path === path)).toBe(false);
    const missing = await get<Session>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ missing: true });
    expect(missing.data.worktree?.branch_missing).toBeUndefined();

    const removed = await post<{ removed: boolean; branch_deleted: boolean }>('/worktrees:remove', { path });

    expect(removed.data).toEqual({ removed: true, branch_deleted: false });
    expect(git(root, 'branch', '--list', branch)).toContain(branch);
    expect(worktreeCount(root)).toBe(1);
  });

  it('removes the worktree with its last session and keeps it while others use it', async () => {
    const { root, workspaceId } = await project('delete-session');
    const first = await settledWorktree(workspaceId);
    const { path, branch } = first.worktree as { path: string; branch: string };
    const second = await post<Session>(`/sessions/${first.id}:fork`, {});
    await post(`/sessions/${second.data.id}:archive`);

    const kept = await post<Deletion>(`/sessions/${first.id}:delete`, {
      remove_worktree: true,
      delete_branch: true,
    });
    expect(kept.data).toEqual({ deleted: true, worktree: { outcome: 'kept_in_use', other_sessions: 1 } });
    expect(existsSync(path)).toBe(true);
    expect(git(root, 'branch', '--list', branch)).toContain(branch);

    const removed = await post<Deletion>(`/sessions/${second.data.id}:delete`, {
      remove_worktree: true,
      delete_branch: true,
    });
    expect(removed.data).toEqual({ deleted: true, worktree: { outcome: 'removed', branch_deleted: true } });
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'branch', '--list', branch)).toBe('');

    const third = await settledWorktree(workspaceId);
    await rm(third.worktree!.path!, { recursive: true, force: true });
    const gone = await post<Deletion>(`/sessions/${third.id}:delete`, { remove_worktree: true });
    expect(gone.data).toEqual({ deleted: true, worktree: { outcome: 'missing', branch_deleted: false } });

    const fourth = await settledWorktree(workspaceId);
    const plainDelete = await post<Deletion>(`/sessions/${fourth.id}:delete`);
    expect(plainDelete.data).toEqual({ deleted: true });
    expect(existsSync(fourth.worktree!.path!)).toBe(true);
    const local = await post<Session>('/sessions', { workspace_id: workspaceId });
    const localDelete = await post<Deletion>(`/sessions/${local.data.id}:delete`, { remove_worktree: true });
    expect(localDelete.data).toEqual({ deleted: true });
    expect(existsSync(root)).toBe(true);
  });

  it('keeps the session deletion when the worktree directory cannot be removed', async () => {
    const { workspaceId } = await project('delete-failure');
    const lockedWorktree = async (): Promise<Session> => {
      const session = await settledWorktree(workspaceId);
      const locked = join(session.worktree!.path!, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'file.txt'), 'x\n');
      await chmod(locked, 0o500);
      onTestFinished(() => chmod(locked, 0o700).catch(() => undefined));
      return session;
    };

    const viaSession = await lockedWorktree();
    const deleted = await post<Deletion>(`/sessions/${viaSession.id}:delete`, { remove_worktree: true });
    expect(deleted.code).toBe(0);
    expect(deleted.data.deleted).toBe(true);
    expect(deleted.data.worktree?.outcome).toBe('failed');
    expect(deleted.data.worktree?.output).toMatch(/locked|permission|EACCES/i);
    expect((await get<Session>(`/sessions/${viaSession.id}`)).code).toBe(ErrorCode.SESSION_NOT_FOUND);

    const direct = await lockedWorktree();
    const removed = await post('/worktrees:remove', { path: direct.worktree!.path! });
    expect(removed.code).toBe(ErrorCode.WORKTREE_REMOVE_FAILED);
    expect(removed.details).toMatchObject({ reason: 'in_use' });
  });

  it('recognises a linked worktree directory and the workspace it belongs to', async () => {
    interface Lookup {
      worktree: null | {
        repo_root: string;
        branch?: string;
        workspace?: { id: string; root: string };
        session_count: number;
      };
    }
    const { root, workspaceId } = await project('lookup');
    const session = await settledWorktree(workspaceId);
    const path = session.worktree!.path!;
    const unregistered = await createRepo('lookup-unregistered');
    const manual = join(fixture.scratch, 'lookup-manual');
    git(unregistered, 'worktree', 'add', '-q', '--detach', manual);

    const product = await post<Lookup>('/worktrees:lookup', { path });
    expect(product.data.worktree).toMatchObject({
      repo_root: root,
      branch: session.worktree!.branch,
      workspace: { id: workspaceId, root },
      session_count: 1,
    });
    const detached = await post<Lookup>('/worktrees:lookup', { path: manual });
    expect(detached.data.worktree).toEqual({ repo_root: unregistered, session_count: 0 });
    for (const other of [root, join(path, 'README.md'), join(fixture.scratch, 'nowhere'), fixture.scratch]) {
      const lookup = await post<Lookup>('/worktrees:lookup', { path: other });
      expect(lookup.data.worktree, other).toBeNull();
    }
  });

  it('names the repository a subfolder sits in and nothing for a repository top folder', async () => {
    const repo = await createRepo('lookup-enclosing');
    const nested = join(repo, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    const lookupOf = async (path: string) =>
      (await post<{ enclosing_repo_root: string | null }>('/worktrees:lookup', { path })).data.enclosing_repo_root;

    expect(await lookupOf(nested)).toBe(repo);
    expect(await lookupOf(repo)).toBeNull();
    expect(await lookupOf(fixture.scratch)).toBeNull();
    expect(await lookupOf(join(fixture.scratch, 'nowhere'))).toBeNull();
  });
});
