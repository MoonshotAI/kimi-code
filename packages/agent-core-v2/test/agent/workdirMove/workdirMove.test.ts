import { castDraft } from 'immer';
import { describe, expect, it } from 'vitest';

import type { WorkdirMoveBaseline } from '#/agent/environmentBinding/environmentBindingOps';
import {
  buildWorkdirMovedReminder,
  extractProjectAgentsMdFiles,
  globalAgentsMdPaths,
  overlaySnapshotHashes,
  selectWorkdirMoveBaseline,
  sha256Hex,
} from '#/agent/workdirMove/workdirMoveReminder';
import { workdirMoveStateKey } from '#/agent/workdirMove/workdirMoveOps';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';

describe('workdirMoveReminder', () => {
  const globals = globalAgentsMdPaths('/Users/alice', '/Users/alice/.kimi-code');

  function baselineOf(
    cwd: string,
    checkoutRoot: string,
    files: Readonly<Record<string, string>>,
    globalSet = globals,
  ): WorkdirMoveBaseline {
    const map = new Map(Object.entries(files));
    return {
      cwd,
      checkoutRoot,
      projectAgentsMd: extractProjectAgentsMdFiles(map, checkoutRoot, globalSet).map(
        ({ relativePath, path, hash }) => ({ relativePath, path, hash }),
      ),
    };
  }

  it('emits only the working directory move line when project AGENTS.md hashes match', () => {
    const baseline = baselineOf('/Users/alice/repo', '/Users/alice/repo', {
      '/Users/alice/.kimi-code/AGENTS.md': 'global rules',
      '/Users/alice/repo/AGENTS.md': 'project rules v1',
    });
    const current = extractProjectAgentsMdFiles(
      new Map([
        ['/Users/alice/.kimi-code/AGENTS.md', 'global rules'],
        ['/Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md', 'project rules v1'],
      ]),
      '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      globals,
    );

    const result = buildWorkdirMovedReminder({
      baseline,
      currentCwd: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentCheckoutRoot: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentProjectFiles: current,
    });

    expect(result).toBeDefined();
    expect(result?.content).toBe(
      'The current working directory has moved from `/Users/alice/repo` to `/Users/alice/.kimi-code/worktrees/repo/1126-kimi`.',
    );
    expect(result?.disclosure).toEqual({
      kind: 'workdir_moved',
      cwd: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      checkoutRoot: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      projectAgentsMd: [
        {
          relativePath: 'AGENTS.md',
          path: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md',
          hash: sha256Hex('project rules v1'),
        },
      ],
    });
  });

  it('appends invalidation and inline replacement without truncating large AGENTS.md files', () => {
    const largeRules = `${'rule line\n'.repeat(4000)}final rule`;
    const baseline = baselineOf('/Users/alice/repo', '/Users/alice/repo', {
      '/Users/alice/repo/AGENTS.md': 'main branch rules',
    });
    const current = extractProjectAgentsMdFiles(
      new Map([['/Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md', largeRules]]),
      '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      globals,
    );

    const result = buildWorkdirMovedReminder({
      baseline,
      currentCwd: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentCheckoutRoot: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentProjectFiles: current,
    });

    expect(result?.content).toBe(
      [
        'The current working directory has moved from `/Users/alice/repo` to `/Users/alice/.kimi-code/worktrees/repo/1126-kimi`.',
        '',
        'The instructions from `/Users/alice/repo/AGENTS.md` no longer apply. The following `AGENTS.md` instructions now apply:',
        '',
        '<!-- From: /Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md -->',
        largeRules,
      ].join('\n'),
    );
  });

  it('omits the invalidation clause when AGENTS.md is newly added in the target worktree', () => {
    const baseline = baselineOf('/Users/alice/repo', '/Users/alice/repo', {});
    const current = extractProjectAgentsMdFiles(
      new Map([['/Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md', 'added rules']]),
      '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      globals,
    );

    const result = buildWorkdirMovedReminder({
      baseline,
      currentCwd: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentCheckoutRoot: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentProjectFiles: current,
    });

    expect(result?.content).toBe(
      [
        'The current working directory has moved from `/Users/alice/repo` to `/Users/alice/.kimi-code/worktrees/repo/1126-kimi`.',
        '',
        'The following `AGENTS.md` instructions now apply:',
        '',
        '<!-- From: /Users/alice/.kimi-code/worktrees/repo/1126-kimi/AGENTS.md -->',
        'added rules',
      ].join('\n'),
    );
  });

  it('announces invalidated instructions when AGENTS.md was deleted in the target worktree', () => {
    const baseline = baselineOf('/Users/alice/repo', '/Users/alice/repo', {
      '/Users/alice/repo/AGENTS.md': 'main branch rules',
    });

    const result = buildWorkdirMovedReminder({
      baseline,
      currentCwd: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentCheckoutRoot: '/Users/alice/.kimi-code/worktrees/repo/1126-kimi',
      currentProjectFiles: [],
    });

    expect(result?.content).toBe(
      [
        'The current working directory has moved from `/Users/alice/repo` to `/Users/alice/.kimi-code/worktrees/repo/1126-kimi`.',
        '',
        'The instructions from `/Users/alice/repo/AGENTS.md` no longer apply.',
      ].join('\n'),
    );
  });

  it('returns undefined when baseline and current working directory match (A -> B -> A)', () => {
    const baseline = baselineOf('/Users/alice/repo', '/Users/alice/repo', {});
    expect(
      buildWorkdirMovedReminder({
        baseline,
        currentCwd: '/Users/alice/repo',
        currentCheckoutRoot: '/Users/alice/repo',
        currentProjectFiles: [],
      }),
    ).toBeUndefined();
  });

  it('selects baselines across consecutive moves, disk edits, and post-compaction re-arming', () => {
    const promptA = baselineOf('/repo', '/repo', { '/repo/AGENTS.md': 'v1' });
    const editedB = baselineOf('/wt/b', '/wt/b', { '/wt/b/AGENTS.md': 'v2-dirty' });

    expect(
      selectWorkdirMoveBaseline({
        state: { originCwd: '/repo', pendingBaseline: promptA },
        lastDisclosure: undefined,
        hasCompactionSummary: false,
        promptBaseline: promptA,
      }),
    ).toEqual(promptA);

    expect(
      selectWorkdirMoveBaseline({
        state: { originCwd: '/repo', pendingBaseline: editedB },
        lastDisclosure: {
          kind: 'workdir_moved',
          cwd: '/wt/b',
          checkoutRoot: '/wt/b',
          projectAgentsMd: [{ relativePath: 'AGENTS.md', path: '/wt/b/AGENTS.md', hash: sha256Hex('v1') }],
        },
        hasCompactionSummary: false,
        promptBaseline: promptA,
      }),
    ).toEqual(editedB);

    expect(
      selectWorkdirMoveBaseline({
        state: { originCwd: '/repo', pendingBaseline: editedB },
        lastDisclosure: undefined,
        hasCompactionSummary: true,
        promptBaseline: promptA,
      }),
    ).toEqual(promptA);
  });

  it('overlays change-notifier snapshot hashes, preserves empty snapshots, and ignores global files', () => {
    const initial = baselineOf('/wt/b', '/wt/b', { '/wt/b/AGENTS.md': 'v1' }).projectAgentsMd;
    expect(overlaySnapshotHashes(initial, undefined, '/wt/b', globals)).toEqual(initial);
    expect(overlaySnapshotHashes(initial, {}, '/wt/b', globals)).toEqual([]);

    const overlaid = overlaySnapshotHashes(
      initial,
      {
        '/Users/alice/.kimi-code/AGENTS.md': sha256Hex('global'),
        '/wt/b/AGENTS.md': sha256Hex('v2-edited'),
      },
      '/wt/b',
      globals,
    );
    expect(overlaid).toEqual([
      {
        relativePath: 'AGENTS.md',
        path: '/wt/b/AGENTS.md',
        hash: sha256Hex('v2-edited'),
      },
    ]);
  });

  it('matches Windows drive letters case-insensitively for global filtering and relative pairing', () => {
    const winGlobals = globalAgentsMdPaths('C:\\Users\\alice', 'C:\\Users\\alice\\.kimi-code');
    const baseline = baselineOf(
      'c:/repo',
      'C:/repo',
      {
        'c:/Users/alice/.kimi-code/AGENTS.md': 'global rules',
        'c:/repo/AGENTS.md': 'project rules v1',
      },
      winGlobals,
    );
    const current = extractProjectAgentsMdFiles(
      new Map([
        ['C:/Users/alice/.kimi-code/AGENTS.md', 'global rules'],
        ['C:/Users/alice/.kimi-code/worktrees/repo/wt/AGENTS.md', 'project rules v1'],
      ]),
      'c:/Users/alice/.kimi-code/worktrees/repo/wt',
      winGlobals,
    );

    const result = buildWorkdirMovedReminder({
      baseline,
      currentCwd: 'C:/Users/alice/.kimi-code/worktrees/repo/wt',
      currentCheckoutRoot: 'C:/Users/alice/.kimi-code/worktrees/repo/wt',
      currentProjectFiles: current,
    });

    expect(result?.content).toBe(
      'The current working directory has moved from `c:/repo` to `C:/Users/alice/.kimi-code/worktrees/repo/wt`.',
    );
  });

  it('clears state fields when rollback dispatches null originCwd and pendingBaseline', () => {
    const baseline = baselineOf('/repo', '/repo', {});
    const fold = workdirMoveStateKey.replayable.folds.get(EnvironmentSetBinding)!;
    const noopCtx = {
      silent: false,
      checkpoint: () => {},
      clearCheckpoints: () => {},
      undoToCheckpoint: () => {},
      emit: () => {},
    };
    const moved = fold(
      {},
      new EnvironmentSetBinding({
        agentId: 'main',
        environmentId: 'local',
        cwd: '/wt',
        originCwd: '/repo',
        pendingBaseline: baseline,
      }),
      noopCtx,
    );
    expect(moved).toEqual({ originCwd: '/repo', pendingBaseline: baseline });

    const rolledBack = fold(
      castDraft(moved ?? {}),
      new EnvironmentSetBinding({
        agentId: 'main',
        environmentId: 'local',
        cwd: '/repo',
        originCwd: null,
        pendingBaseline: null,
      }),
      noopCtx,
    );
    expect(rolledBack).toEqual({ originCwd: undefined, pendingBaseline: undefined });
  });
});
