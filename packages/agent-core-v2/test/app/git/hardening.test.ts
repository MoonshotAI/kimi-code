import { describe, expect, it } from 'vitest';

import {
  buildDriverOverrides,
  INCLUDE_SECTION_RE,
  isCoreWorktreeSafe,
  parseGitDirPointer,
  resolveConfigPaths,
} from '#/app/git/hardening';

describe('buildDriverOverrides', () => {
  it('neutralizes filter and merge drivers found in probe output', () => {
    expect(buildDriverOverrides(['filter.evil.clean\nfilter.evil.process\nfilter.evil.smudge\nmerge.evil.driver\n'])).toEqual([
      '-c',
      'filter.evil.clean=',
      '-c',
      'filter.evil.process=',
      '-c',
      'filter.evil.smudge=',
      '-c',
      'merge.evil.driver=',
    ]);
  });

  it('returns null when a driver name contains an equals sign', () => {
    expect(buildDriverOverrides(['filter.evil=x.clean\n'])).toBeNull();
    expect(buildDriverOverrides(['merge.evil=x.driver\n'])).toBeNull();
  });

  it('ignores unrelated keys and empty output', () => {
    expect(buildDriverOverrides(['core.fsmonitor\n', ''])).toEqual([]);
  });
});

describe('parseGitDirPointer', () => {
  it('reads the pointer from the first line', () => {
    expect(parseGitDirPointer('gitdir: ../actual-git\n')).toBe('../actual-git');
    expect(parseGitDirPointer('\uFEFF gitdir: /abs/gitdir\r\nsecond')).toBe('/abs/gitdir');
  });

  it('returns undefined for content without a gitdir pointer', () => {
    expect(parseGitDirPointer('not a pointer')).toBeUndefined();
    expect(parseGitDirPointer('gitdir:\n')).toBeUndefined();
  });
});

describe('resolveConfigPaths', () => {
  it('lists the per-worktree config files', () => {
    expect(resolveConfigPaths('/repo/.git', undefined)).toEqual([
      '/repo/.git/config',
      '/repo/.git/config.worktree',
    ]);
  });

  it('adds the common config when a commondir file exists', () => {
    expect(resolveConfigPaths('/repo/.git/worktrees/wt', '../..\n')).toEqual([
      '/repo/.git/worktrees/wt/config',
      '/repo/.git/worktrees/wt/config.worktree',
      '/repo/.git/config',
    ]);
  });
});

describe('isCoreWorktreeSafe', () => {
  it('accepts a worktree that resolves to the work tree root', () => {
    expect(isCoreWorktreeSafe('/repo', '/repo/.git', '/repo')).toBe(true);
    expect(isCoreWorktreeSafe('..', '/repo/.git', '/repo')).toBe(true);
  });

  it('rejects a worktree that resolves anywhere else', () => {
    expect(isCoreWorktreeSafe('/outside', '/repo/.git', '/repo')).toBe(false);
    expect(isCoreWorktreeSafe('../..', '/repo/.git', '/repo')).toBe(false);
  });

  it('compares with Windows path semantics', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(isCoreWorktreeSafe('/REPO', '/repo/.git', '/repo')).toBe(true);
      expect(isCoreWorktreeSafe('/OTHER', '/repo/.git', '/repo')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});

describe('INCLUDE_SECTION_RE', () => {
  it('matches include and includeIf section headers', () => {
    expect(INCLUDE_SECTION_RE.test('[include]\n\tpath = extra.conf')).toBe(true);
    expect(INCLUDE_SECTION_RE.test('[includeIf "gitdir:~/src/**"]')).toBe(true);
    expect(INCLUDE_SECTION_RE.test('  [IncludeIf "gitdir:~/src/**"]')).toBe(true);
  });

  it('does not match include mentions outside section headers', () => {
    expect(INCLUDE_SECTION_RE.test('url = https://example.com/include.git')).toBe(false);
    expect(INCLUDE_SECTION_RE.test('[includefoo]')).toBe(false);
  });
});
