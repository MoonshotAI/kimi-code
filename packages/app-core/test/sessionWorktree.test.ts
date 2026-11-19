import { describe, expect, it } from 'vitest';

import type { AppSessionWorktree, AppWorktree, WorkspaceGitBranches } from '../src/api/types';
import {
  buildWorktreeSetupRequest,
  canIncludeLocalChanges,
  classifySessionEnvironment,
  groupWorktreesByProject,
  isSessionWorktreeInvalid,
  isSessionWorktreeSettingUp,
  isWorktreeSession,
  resolveWorktreeSource,
  sessionDirectoryRoots,
  sessionEnvironmentTag,
  sessionMainDirectory,
  sessionWorktreeBlocksSend,
  sessionWorktreeCard,
  sessionWorktreeHoldsPrompts,
} from '../src/lib/sessionWorktree';

function worktree(
  status: AppSessionWorktree['setup']['status'],
  overrides: Partial<AppSessionWorktree> = {},
  setup: Partial<AppSessionWorktree['setup']> = {},
): AppSessionWorktree {
  return {
    path: '/wt/a',
    branch: 'kimi/a',
    ...overrides,
    setup: {
      status,
      purpose: 'create',
      request: { sourceBranch: 'main' },
      steps: [],
      commandsRan: 0,
      startedAt: '2026-11-18T00:00:00.000Z',
      script: 'none',
      ...setup,
    },
  };
}

describe('classifySessionEnvironment', () => {
  it('treats sessions without a worktree as local', () => {
    expect(classifySessionEnvironment(undefined)).toBe('local');
    expect(classifySessionEnvironment({})).toBe('local');
  });

  it('treats a session that fell back to local mode as local', () => {
    const session = { worktree: worktree('local') };
    expect(classifySessionEnvironment(session)).toBe('local');
    expect(isWorktreeSession(session)).toBe(false);
  });

  it('reports setting up while the setup runs, even before a path exists', () => {
    const session = { worktree: worktree('running', { path: undefined }) };
    expect(classifySessionEnvironment(session)).toBe('settingUp');
    expect(isSessionWorktreeSettingUp(session)).toBe(true);
    expect(isWorktreeSession(session)).toBe(false);
  });

  it('reports a ready worktree', () => {
    expect(classifySessionEnvironment({ worktree: worktree('ready') })).toBe('worktree');
  });

  it('reports a missing worktree as invalid', () => {
    const session = { worktree: worktree('ready', { missing: true }) };
    expect(classifySessionEnvironment(session)).toBe('invalid');
    expect(isSessionWorktreeInvalid(session)).toBe(true);
  });

  it('prefers setting up over invalid while a recreate runs', () => {
    expect(classifySessionEnvironment({ worktree: worktree('running', { missing: true }, { purpose: 'recreate' }) })).toBe('settingUp');
  });

  it('keeps a failed creation without a directory local', () => {
    expect(classifySessionEnvironment({ worktree: worktree('failed', { path: undefined }) })).toBe('local');
  });

  it('tags a session unless it is local', () => {
    expect(sessionEnvironmentTag({ worktree: worktree('local') })).toBeUndefined();
    expect(sessionEnvironmentTag({ worktree: worktree('ready') })).toBe('worktree');
  });
});

describe('prompt gating predicates', () => {
  it.each([
    ['running', true],
    ['failed', true],
    ['stopped', true],
    ['awaiting_script_confirmation', true],
    ['ready', false],
    ['local', false],
  ] as const)('holds prompts while status is %s: %s', (status, held) => {
    expect(sessionWorktreeHoldsPrompts({ worktree: worktree(status) })).toBe(held);
  });

  it('does not hold local sessions', () => {
    expect(sessionWorktreeHoldsPrompts({})).toBe(false);
    expect(sessionWorktreeBlocksSend({})).toBe(false);
  });

  it('blocks sending into a missing worktree but only holds while it is recreated', () => {
    expect(sessionWorktreeBlocksSend({ worktree: worktree('ready', { missing: true }) })).toBe(true);
    const recreating = { worktree: worktree('running', { missing: true }, { purpose: 'recreate' }) };
    expect(sessionWorktreeBlocksSend(recreating)).toBe(false);
    expect(sessionWorktreeHoldsPrompts(recreating)).toBe(true);
  });
});

describe('sessionWorktreeCard', () => {
  it('shows no card for local, running, ready or local-fallback sessions', () => {
    expect(sessionWorktreeCard(undefined)).toBeNull();
    expect(sessionWorktreeCard(worktree('running'))).toBeNull();
    expect(sessionWorktreeCard(worktree('ready'))).toBeNull();
    expect(sessionWorktreeCard(worktree('local', { missing: true }))).toBeNull();
  });

  it.each([
    ['fetch_failed', 'fetchFailed'],
    ['fetch_timeout', 'fetchTimeout'],
    ['conflict', 'conflict'],
    ['disk_full', 'diskFull'],
    ['create_failed', 'createFailed'],
    ['script_failed', 'scriptFailed'],
    ['script_timeout', 'scriptTimeout'],
  ] as const)('maps the %s failure to the %s card', (kind, card) => {
    expect(sessionWorktreeCard(worktree('failed', {}, { failure: { kind } }))).toBe(card);
  });

  it('distinguishes a stopped script from a stopped creation', () => {
    expect(sessionWorktreeCard(worktree('stopped', {}, { stoppedStep: 'script' }))).toBe('scriptStopped');
    expect(sessionWorktreeCard(worktree('stopped', {}, { stoppedStep: 'fetch' }))).toBe('stopped');
    expect(sessionWorktreeCard(worktree('stopped'))).toBe('stopped');
  });

  it('asks for confirmation before running a repository script', () => {
    expect(sessionWorktreeCard(worktree('awaiting_script_confirmation'))).toBe('scriptConfirm');
  });

  it('reports a missing directory, and separately a missing branch', () => {
    expect(sessionWorktreeCard(worktree('ready', { missing: true }))).toBe('missing');
    expect(sessionWorktreeCard(worktree('ready', { missing: true, branchMissing: true }))).toBe('missingBranchGone');
  });

  it('never treats a failure as a stop even though the failed step is recorded', () => {
    expect(
      sessionWorktreeCard(worktree('failed', {}, { stoppedStep: 'fetch', failure: { kind: 'fetch_timeout' } })),
    ).toBe('fetchTimeout');
    expect(
      sessionWorktreeCard(worktree('failed', {}, { stoppedStep: 'create', failure: { kind: 'disk_full' } })),
    ).toBe('diskFull');
    expect(
      sessionWorktreeCard(worktree('failed', {}, { stoppedStep: 'script', failure: { kind: 'script_failed', exitCode: 1 } })),
    ).toBe('scriptFailed');
    expect(sessionWorktreeCard(worktree('failed', {}, { stoppedStep: 'script' }))).toBe('scriptFailed');
    expect(sessionWorktreeCard(worktree('failed', {}, { stoppedStep: 'prune' }))).toBe('createFailed');
  });

  it('shows the recreate failure rather than the missing card', () => {
    expect(
      sessionWorktreeCard(worktree('failed', { missing: true }, { purpose: 'recreate', failure: { kind: 'disk_full' } })),
    ).toBe('diskFull');
  });
});

describe('sessionMainDirectory', () => {
  it('uses the project root for local sessions', () => {
    expect(sessionMainDirectory({ cwd: '/repo/sub' }, '/repo')).toBe('/repo');
    expect(sessionMainDirectory({ cwd: '/repo' }, undefined)).toBe('/repo');
    expect(sessionMainDirectory(undefined, '/repo')).toBe('/repo');
    expect(sessionMainDirectory(undefined, undefined)).toBe('');
  });

  it('uses the session directory for worktree sessions', () => {
    expect(sessionMainDirectory({ cwd: '/wt/a', worktree: worktree('ready') }, '/repo')).toBe('/wt/a');
    expect(sessionMainDirectory({ cwd: '/wt/a', worktree: worktree('ready', { missing: true }) }, '/repo')).toBe('/wt/a');
  });

  it('uses the worktree as soon as it exists, before the setup script has finished', () => {
    const states = [
      worktree('running'),
      worktree('awaiting_script_confirmation'),
      worktree('failed', {}, { stoppedStep: 'script', failure: { kind: 'script_failed' } }),
      worktree('stopped', {}, { stoppedStep: 'script' }),
    ];
    for (const state of states) {
      expect(sessionMainDirectory({ cwd: '/wt/a', worktree: state }, '/repo')).toBe('/wt/a');
      expect(isWorktreeSession({ worktree: state })).toBe(true);
    }
    expect(sessionMainDirectory({ cwd: '/repo', worktree: worktree('running') }, '/repo')).toBe('/wt/a');
    expect(classifySessionEnvironment({ worktree: worktree('running') })).toBe('settingUp');
    expect(classifySessionEnvironment({ worktree: worktree('awaiting_script_confirmation') })).toBe('worktree');
    expect(sessionWorktreeHoldsPrompts({ worktree: worktree('awaiting_script_confirmation') })).toBe(true);
  });

  it('returns to the project root once a missing worktree was abandoned', () => {
    const abandoned = worktree('local', { path: undefined, branch: undefined, missing: true });
    expect(sessionMainDirectory({ cwd: '/repo', worktree: abandoned }, '/repo')).toBe('/repo');
    expect(classifySessionEnvironment({ worktree: abandoned })).toBe('local');
    expect(sessionWorktreeBlocksSend({ worktree: abandoned })).toBe(false);
  });

  it('stays on the project root while the worktree is being created and after falling back', () => {
    expect(sessionMainDirectory({ cwd: '/repo', worktree: worktree('running', { path: undefined }) }, '/repo')).toBe('/repo');
    expect(sessionMainDirectory({ cwd: '/repo', worktree: worktree('local') }, '/repo')).toBe('/repo');
  });

  it('lists the main directory before additional directories', () => {
    const workspace = { root: '/repo', additionalDirs: ['/extra'] };
    expect(sessionDirectoryRoots({ cwd: '/wt/a', worktree: worktree('ready') }, workspace)).toEqual(['/wt/a', '/extra']);
    expect(sessionDirectoryRoots({ cwd: '/repo' }, workspace)).toEqual(['/repo', '/extra']);
    expect(sessionDirectoryRoots(undefined, undefined)).toEqual([]);
  });
});

describe('worktree source resolution', () => {
  const info: WorkspaceGitBranches = {
    isRepo: true,
    remotes: ['origin'],
    headBranch: 'main',
    dirty: true,
    branches: [
      { name: 'topic', committedAt: '2026-11-18T00:00:00.000Z' },
      { name: 'main', committedAt: '2026-11-17T00:00:00.000Z', remoteRef: 'origin/main' },
    ],
  };

  it('defaults to the current branch without local changes', () => {
    expect(resolveWorktreeSource(info)).toEqual({ branch: info.branches[1], includeLocalChanges: false, isDefault: true });
  });

  it('falls back to the newest branch when HEAD is detached', () => {
    expect(resolveWorktreeSource({ ...info, headBranch: undefined })?.branch.name).toBe('topic');
  });

  it('uses the remembered branch while it exists', () => {
    expect(resolveWorktreeSource(info, { branch: 'topic' })).toEqual({
      branch: info.branches[0],
      includeLocalChanges: false,
      isDefault: false,
    });
  });

  it('restores the default when the remembered branch was deleted', () => {
    expect(resolveWorktreeSource(info, { branch: 'gone', includeLocalChanges: true })).toEqual({
      branch: info.branches[1],
      includeLocalChanges: false,
      isDefault: true,
    });
  });

  it('offers local changes only for the dirty current branch', () => {
    expect(canIncludeLocalChanges(info, 'main')).toBe(true);
    expect(canIncludeLocalChanges(info, 'topic')).toBe(false);
    expect(canIncludeLocalChanges({ ...info, dirty: false }, 'main')).toBe(false);
    expect(resolveWorktreeSource(info, { branch: 'main', includeLocalChanges: true })?.includeLocalChanges).toBe(true);
    expect(resolveWorktreeSource({ ...info, dirty: false }, { branch: 'main', includeLocalChanges: true })?.includeLocalChanges).toBe(false);
    expect(resolveWorktreeSource(info, { branch: 'topic', includeLocalChanges: true })?.includeLocalChanges).toBe(false);
  });

  it('resolves nothing outside a repository or without branches', () => {
    expect(resolveWorktreeSource(null)).toBeNull();
    expect(resolveWorktreeSource({ isRepo: false, dirty: false, remotes: [], branches: [] })).toBeNull();
    expect(resolveWorktreeSource({ isRepo: true, dirty: false, remotes: [], branches: [] })).toBeNull();
  });

  it('builds the request, using the remote only when the branch has one', () => {
    const main = resolveWorktreeSource(info, { branch: 'main', includeLocalChanges: true })!;
    expect(buildWorktreeSetupRequest(main, { useRemote: true })).toEqual({
      sourceBranch: 'main',
      includeLocalChanges: true,
      useRemote: true,
    });
    const topic = resolveWorktreeSource(info, { branch: 'topic' })!;
    expect(buildWorktreeSetupRequest(topic, { useRemote: true, runSetupScript: false })).toEqual({
      sourceBranch: 'topic',
      runSetupScript: false,
    });
    expect(buildWorktreeSetupRequest(main)).toEqual({ sourceBranch: 'main', includeLocalChanges: true });
  });
});

describe('groupWorktreesByProject', () => {
  function item(path: string, overrides: Partial<AppWorktree>): AppWorktree {
    return { path, name: path, repoRoot: '/repo', origin: 'product', sessions: [], ...overrides };
  }

  it('groups by project in first-seen order and sums known sizes', () => {
    const groups = groupWorktreesByProject([
      item('/wt/a', { workspaceId: 'ws-1', workspaceName: 'Repo', sizeBytes: 10 }),
      item('/wt/x', { repoRoot: '/other/thing' }),
      item('/wt/b', { workspaceId: 'ws-1', workspaceName: 'Repo', sizeBytes: 5 }),
    ]);
    expect(groups.map((group) => [group.key, group.name, group.items.map((entry) => entry.path), group.sizeBytes])).toEqual([
      ['ws-1', 'Repo', ['/wt/a', '/wt/b'], 15],
      ['/other/thing', 'thing', ['/wt/x'], undefined],
    ]);
  });
});
