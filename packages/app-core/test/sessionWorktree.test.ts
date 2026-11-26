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
  sessionEnvironmentTag,
  sessionWorktreeBlocksSend,
  sessionWorktreeCard,
  sessionWorkingDirectory,
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
      ...setup,
    },
  };
}

describe('classifySessionEnvironment', () => {
  it.each([
    ['no worktree', undefined, 'local'],
    ['a local fallback', worktree('local'), 'local'],
    ['a failed creation without a directory', worktree('failed', { path: undefined }), 'local'],
    ['a setup running before a path exists', worktree('running', { path: undefined }), 'settingUp'],
    ['a setup running in an existing directory', worktree('running'), 'settingUp'],
    ['a recreate running on a missing worktree', worktree('running', { missing: true }, { purpose: 'recreate' }), 'settingUp'],
    ['a ready worktree', worktree('ready'), 'worktree'],
    ['a missing worktree', worktree('ready', { missing: true }), 'invalid'],
  ] as const)('classifies %s as %s', (_label, value, expected) => {
    expect(classifySessionEnvironment({ worktree: value })).toBe(expected);
  });

  it('matches the narrower predicates and the tag', () => {
    expect(classifySessionEnvironment(undefined)).toBe('local');
    expect(isWorktreeSession({ worktree: worktree('local') })).toBe(false);
    expect(isWorktreeSession({ worktree: worktree('running', { path: undefined }) })).toBe(false);
    expect(isWorktreeSession({ worktree: worktree('running') })).toBe(true);
    expect(isSessionWorktreeSettingUp({ worktree: worktree('running', { path: undefined }) })).toBe(true);
    expect(isSessionWorktreeInvalid({ worktree: worktree('ready', { missing: true }) })).toBe(true);
    expect(sessionEnvironmentTag({ worktree: worktree('local') })).toBeUndefined();
    expect(sessionEnvironmentTag({ worktree: worktree('ready') })).toBe('worktree');
  });
});

describe('prompt gating predicates', () => {
  it.each([
    ['running', true],
    ['failed', true],
    ['stopped', true],
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
  it.each([
    ['no worktree', undefined, null],
    ['a running setup', worktree('running'), null],
    ['a ready worktree', worktree('ready'), null],
    ['a local fallback from a missing worktree', worktree('local', { missing: true }), null],
    ['a fetch failure', worktree('failed', {}, { failure: { kind: 'fetch_failed' } }), 'fetchFailed'],
    ['a fetch timeout', worktree('failed', {}, { stoppedStep: 'fetch', failure: { kind: 'fetch_timeout' } }), 'fetchTimeout'],
    ['a conflict', worktree('failed', {}, { failure: { kind: 'conflict' } }), 'conflict'],
    ['a full disk', worktree('failed', {}, { stoppedStep: 'create', failure: { kind: 'disk_full' } }), 'diskFull'],
    ['a create failure', worktree('failed', {}, { failure: { kind: 'create_failed' } }), 'createFailed'],
    ['a failure without a kind', worktree('failed', {}, { stoppedStep: 'prune' }), 'createFailed'],
    ['a stop at the fetch', worktree('stopped', {}, { stoppedStep: 'fetch' }), 'stopped'],
    ['a stop without a step', worktree('stopped'), 'stopped'],
    ['a missing directory', worktree('ready', { missing: true }), 'missing'],
    ['a missing directory and branch', worktree('ready', { missing: true, branchMissing: true }), 'missingBranchGone'],
    [
      'a failed recreate of a missing worktree',
      worktree('failed', { missing: true }, { purpose: 'recreate', failure: { kind: 'disk_full' } }),
      'diskFull',
    ],
  ] as const)('shows for %s: %s', (_label, value, card) => {
    expect(sessionWorktreeCard(value)).toBe(card);
  });
});

describe('sessionWorkingDirectory', () => {
  it.each([
    ['a local session', undefined, '/repo/sub', '/repo/sub'],
    ['a ready worktree', worktree('ready'), '/wt/a', '/wt/a'],
    ['a missing worktree', worktree('ready', { missing: true }), '/wt/a', '/wt/a'],
    ['a setup running in an existing directory', worktree('running'), '/repo', '/wt/a'],
    ['a setup running before a path exists', worktree('running', { path: undefined }), '/repo', '/repo'],
    ['a local fallback', worktree('local'), '/repo', '/repo'],
    ['an abandoned missing worktree', worktree('local', { path: undefined, branch: undefined, missing: true }), '/repo', '/repo'],
  ] as const)('uses the right directory for %s', (_label, value, cwd, expected) => {
    expect(sessionWorkingDirectory({ cwd, worktree: value })).toBe(expected);
  });

  it('stops blocking sends once a missing worktree was abandoned', () => {
    const abandoned = worktree('local', { path: undefined, branch: undefined, missing: true });
    expect(classifySessionEnvironment({ worktree: abandoned })).toBe('local');
    expect(sessionWorktreeBlocksSend({ worktree: abandoned })).toBe(false);
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
    expect(buildWorktreeSetupRequest(topic, { useRemote: true })).toEqual({ sourceBranch: 'topic' });
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
