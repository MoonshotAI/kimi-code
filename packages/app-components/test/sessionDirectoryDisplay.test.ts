import { describe, expect, it } from 'vitest';
import {
  pullRequestIcon,
  pullRequestStateKey,
  pullRequestStateLabel,
  sessionWorktreeDisplay,
  shortenHomePath,
} from '../src/worktree/sessionDirectoryDisplay';

type Source = NonNullable<Parameters<typeof sessionWorktreeDisplay>[0]>;

function source(worktree: Record<string, unknown>): Source {
  return { worktree } as unknown as Source;
}

describe('sessionWorktreeDisplay', () => {
  it('returns nothing for a local session', () => {
    expect(sessionWorktreeDisplay(null)).toBeNull();
    expect(sessionWorktreeDisplay({})).toBeNull();
  });

  it('returns nothing while the worktree has no directory', () => {
    expect(sessionWorktreeDisplay(source({ setup: { status: 'running' } }))).toBeNull();
  });

  it('returns nothing after the session fell back to local mode', () => {
    expect(sessionWorktreeDisplay(source({ path: '/wt', setup: { status: 'local' } }))).toBeNull();
  });

  it.each(['ready', 'running'])(
    'describes the worktree once its directory exists (%s)',
    (status) => {
      expect(
        sessionWorktreeDisplay(
          source({ path: '/wt', branch: 'kimi/1', base: { ref: 'origin/main', remote: true }, setup: { status } }),
        ),
      ).toEqual({ path: '/wt', branch: 'kimi/1', base: { ref: 'origin/main', remote: true }, missing: false });
    },
  );

  it('flags a missing worktree directory', () => {
    expect(sessionWorktreeDisplay(source({ path: '/wt', missing: true, setup: { status: 'ready' } }))).toEqual({
      path: '/wt',
      branch: null,
      base: null,
      missing: true,
    });
  });
});

describe('shortenHomePath', () => {
  it('abbreviates the known home directory', () => {
    expect(shortenHomePath('/Users/me/.kimi-code/worktrees/a', '/Users/me')).toBe('~/.kimi-code/worktrees/a');
    expect(shortenHomePath('/Users/me', '/Users/me/')).toBe('~');
  });

  it('does not treat a sibling directory as home', () => {
    expect(shortenHomePath('/opt/me-too/a', '/opt/me')).toBe('/opt/me-too/a');
  });

  it('abbreviates conventional home directories when home is unknown', () => {
    expect(shortenHomePath('/home/dev/project', null)).toBe('~/project');
    expect(shortenHomePath('/srv/project', null)).toBe('/srv/project');
  });
});

describe('pull request state', () => {
  it('normalizes the state for labels and icons', () => {
    expect(pullRequestStateKey(' MERGED ')).toBe('merged');
    expect(pullRequestStateLabel('draft')).toBe('Draft');
    expect(pullRequestStateLabel('something')).toBe('Unknown');
    expect(pullRequestIcon('merged')).toBe('git-merge');
    expect(pullRequestIcon('open')).toBe('git-pull-request');
  });
});
