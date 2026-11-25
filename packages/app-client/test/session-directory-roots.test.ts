import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppWorkspace } from '@moonshot-ai/app-core/api';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';
import { appSession, sessionWorktree } from '../src/testing/worktreeFixtures';

function workspace(id: string, root: string, additionalDirs: string[] = []): AppWorkspace {
  return { id, root, name: id, kind: 'managed', additionalDirs, sessionCount: 1 };
}

beforeEach(() => {
  workspacesStore().workspaces = [workspace('ws1', '/repo', ['/extra']), workspace('ws2', '/other')];
  workspacesStore().hiddenWorkspaceIds = [];
  sessionsStore().setSessions([
    appSession({ id: 'ready', cwd: '/wt/a', workspaceId: 'ws1', worktree: sessionWorktree('ready', { path: '/wt/a' }) }),
    appSession({ id: 'creating', cwd: '/repo', workspaceId: 'ws1', worktree: sessionWorktree('running', { path: '/wt/b' }) }),
  ]);
});

afterEach(() => {
  workspacesStore().workspaces = [];
  sessionsStore().setSessions([]);
});

describe('workspacesStore panel roots', () => {
  const session = (id: string) => sessionsStore().sessions.find((item) => item.id === id)!;

  it('uses the worktree directory once a worktree session is ready', () => {
    expect(workspacesStore().sessionPanelRoots(session('ready'))).toEqual({ root: '/wt/a', roots: ['/wt/a', '/extra'] });
  });

  it('uses the worktree directory while the worktree is still being set up', () => {
    expect(workspacesStore().sessionPanelRoots(session('creating'))).toEqual({ root: '/wt/b', roots: ['/wt/b', '/extra'] });
  });
});
