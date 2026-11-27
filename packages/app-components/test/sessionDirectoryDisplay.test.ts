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
  it.each([
    ['a missing session', null],
    ['a local session', {}],
    ['a worktree without a directory yet', source({ setup: { status: 'running' } })],
    ['a session that fell back to local mode', source({ path: '/wt', setup: { status: 'local' } })],
  ])('returns nothing for %s', (_label, value) => {
    expect(sessionWorktreeDisplay(value)).toBeNull();
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
  it.each<[string, string, string | null, string]>([
    ['the known home directory', '/Users/me/.kimi-code/worktrees/a', '/Users/me', '~/.kimi-code/worktrees/a'],
    ['home itself, ignoring a trailing slash', '/Users/me', '/Users/me/', '~'],
    ['a conventional home directory when home is unknown', '/home/dev/project', null, '~/project'],
  ])('abbreviates %s', (_label, path, home, expected) => {
    expect(shortenHomePath(path, home)).toBe(expected);
  });

  it.each<[string, string, string | null]>([
    ['a sibling of home', '/opt/me-too/a', '/opt/me'],
    ['a path outside any home when home is unknown', '/srv/project', null],
  ])('keeps %s unchanged', (_label, path, home) => {
    expect(shortenHomePath(path, home)).toBe(path);
  });
});

describe('pull request state', () => {
  it.each<[string, string, string]>([
    [' MERGED ', 'merged', 'git-merge'],
    ['open', 'open', 'git-pull-request'],
    ['draft', 'draft', 'git-pull-request'],
    ['something', 'unknown', 'git-pull-request'],
  ])('normalizes %j to %s with the %s icon', (state, key, icon) => {
    expect(pullRequestStateKey(state)).toBe(key);
    expect(pullRequestIcon(state)).toBe(icon);
  });

  it('labels a known state and falls back for an unknown one', () => {
    expect(pullRequestStateLabel('draft')).toContain('Draft');
    expect(pullRequestStateLabel('something')).toContain('Unknown');
  });
});
