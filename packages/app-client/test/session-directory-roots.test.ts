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
  ]);
});

afterEach(() => {
  workspacesStore().workspaces = [];
  sessionsStore().setSessions([]);
});

describe('workspacesStore directory roots', () => {
  it('uses the project root for a draft', () => {
    expect(workspacesStore().directoryRootsFor(null, 'ws1')).toEqual(['/repo', '/extra']);
    expect(workspacesStore().mainDirectoryFor(undefined, 'ws2')).toBe('/other');
  });

  it('uses the worktree directory once a worktree session is ready', () => {
    expect(workspacesStore().directoryRootsFor('ready')).toEqual(['/wt/a', '/extra']);
    expect(workspacesStore().mainDirectoryFor('ready', 'ws1')).toBe('/wt/a');
  });

  it('returns nothing without a session or project', () => {
    expect(workspacesStore().directoryRootsFor(null, null)).toEqual([]);
    expect(workspacesStore().mainDirectoryFor('unknown')).toBe('');
  });
});
