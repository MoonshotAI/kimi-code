import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IEventService, ISessionService, IWorkspaceRegistry } from '../../src/services';
import {
  WorktreeConflictError,
  WorktreeGitUnavailableError,
  WorktreeService,
} from '../../src/services';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-test-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  return root;
}

let sessionItems: Array<{ id: string; metadata: { cwd: string } }> = [];
let published: Array<{ type: string; change: string }> = [];

function buildService(root: string): WorktreeService {
  const workspaces = {
    resolveRoot: vi.fn().mockResolvedValue(root),
  } as unknown as IWorkspaceRegistry;
  const sessions = {
    list: vi.fn().mockImplementation(async () => ({
      items: sessionItems,
      has_more: false,
    })),
  } as unknown as ISessionService;
  const eventService = {
    publish: vi.fn((e: { type: string; change: string }) => {
      published.push({ type: e.type, change: e.change });
    }),
  } as unknown as IEventService;
  return new WorktreeService(workspaces, sessions, eventService);
}

let root: string;

beforeEach(async () => {
  root = await makeRepo();
  sessionItems = [];
  published = [];
});

afterEach(async () => {
  if (root !== undefined) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('WorktreeService', () => {
  it('lists the main worktree on a fresh repo', async () => {
    const service = buildService(root);
    const list = await service.list('ws');
    expect(list).toHaveLength(1);
    expect(list[0]?.is_main).toBe(true);
    expect(list[0]?.session_id).toBeNull();
    expect(list[0]?.pull_request).toBeNull();
  });

  it('creates a worktree and lists it as non-main', async () => {
    const service = buildService(root);
    const created = await service.create('ws', { branch: 'feat-x' });
    expect(created.branch).toBe('feat-x');
    expect(created.is_main).toBe(false);
    expect(created.dirty).toBe(false);
    expect(created.path).toContain('.worktrees');

    const list = await service.list('ws');
    expect(list).toHaveLength(2);
    expect(list.some((w) => w.branch === 'feat-x' && !w.is_main)).toBe(true);
    expect(published).toContainEqual({ type: 'event.worktree.changed', change: 'created' });
  });

  it('correlates a session whose cwd is the worktree path', async () => {
    const service = buildService(root);
    const created = await service.create('ws', { branch: 'feat-y' });
    sessionItems = [{ id: 'sess-1', metadata: { cwd: created.path } }];

    const list = await service.list('ws');
    const match = list.find((w) => w.branch === 'feat-y');
    expect(match?.session_id).toBe('sess-1');
  });

  it('removes a worktree', async () => {
    const service = buildService(root);
    const created = await service.create('ws', { branch: 'feat-z' });
    await service.remove('ws', { path: created.path });
    const list = await service.list('ws');
    expect(list).toHaveLength(1);
    expect(published).toContainEqual({ type: 'event.worktree.changed', change: 'removed' });
  });

  it('refuses to remove the main worktree', async () => {
    const service = buildService(root);
    const list = await service.list('ws');
    const main = list[0];
    if (main === undefined) throw new Error('missing main');
    await expect(service.remove('ws', { path: main.path })).rejects.toBeInstanceOf(
      WorktreeConflictError,
    );
  });

  it('throws git-unavailable for a non-git directory', async () => {
    const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-nogit-'));
    try {
      const service = buildService(notGit);
      await expect(service.list('ws')).rejects.toBeInstanceOf(WorktreeGitUnavailableError);
    } finally {
      await fs.rm(notGit, { recursive: true, force: true });
    }
  });
});
