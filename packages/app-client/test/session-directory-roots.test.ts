import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppSession, AppWorkspace } from '@moonshot-ai/app-core/api';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';

function workspace(id: string, root: string, additionalDirs: string[] = []): AppWorkspace {
  return { id, root, name: id, kind: 'managed', additionalDirs, sessionCount: 1 };
}

function worktreeSession(id: string, status: 'running' | 'ready' | 'local', cwd: string): AppSession {
  return {
    id,
    cwd,
    workspaceId: 'ws1',
    worktree: {
      path: status === 'running' ? undefined : '/wt/a',
      setup: {
        status,
        purpose: 'create',
        request: { sourceBranch: 'main' },
        steps: [],
        commandsRan: 0,
        startedAt: '2026-11-18T00:00:00.000Z',
        script: 'none',
      },
    },
  } as AppSession;
}

beforeEach(() => {
  workspacesStore().workspaces = [workspace('ws1', '/repo', ['/extra']), workspace('ws2', '/other')];
  workspacesStore().hiddenWorkspaceIds = [];
  sessionsStore().setSessions([
    { id: 'local', cwd: '/repo', workspaceId: 'ws1' } as AppSession,
    worktreeSession('ready', 'ready', '/wt/a'),
    worktreeSession('running', 'running', '/repo'),
    worktreeSession('fallback', 'local', '/repo'),
  ]);
});

afterEach(() => {
  workspacesStore().workspaces = [];
  sessionsStore().setSessions([]);
});

describe('workspacesStore directory roots', () => {
  it('uses the project root for local sessions and drafts', () => {
    expect(workspacesStore().directoryRootsFor('local')).toEqual(['/repo', '/extra']);
    expect(workspacesStore().directoryRootsFor(null, 'ws1')).toEqual(['/repo', '/extra']);
    expect(workspacesStore().mainDirectoryFor(undefined, 'ws2')).toBe('/other');
  });

  it('uses the worktree directory once a worktree session is ready', () => {
    expect(workspacesStore().directoryRootsFor('ready')).toEqual(['/wt/a', '/extra']);
    expect(workspacesStore().mainDirectoryFor('ready', 'ws1')).toBe('/wt/a');
  });

  it('stays on the project root during setup and after falling back to local mode', () => {
    expect(workspacesStore().mainDirectoryFor('running')).toBe('/repo');
    expect(workspacesStore().mainDirectoryFor('fallback')).toBe('/repo');
  });

  it('returns nothing without a session or project', () => {
    expect(workspacesStore().directoryRootsFor(null, null)).toEqual([]);
    expect(workspacesStore().mainDirectoryFor('unknown')).toBe('');
  });
});
