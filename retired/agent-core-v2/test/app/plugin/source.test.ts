import { describe, expect, it } from 'vitest';

import { resolveInstallSource } from '#/app/plugin/source';

describe('resolveInstallSource', () => {
  it('resolves absolute local paths', () => {
    expect(resolveInstallSource('/tmp/plugin')).toEqual({ kind: 'local-path', path: '/tmp/plugin' });
  });

  it('resolves zip urls', () => {
    expect(resolveInstallSource('https://example.com/plugin.zip')).toEqual({
      kind: 'zip-url',
      path: 'https://example.com/plugin.zip',
    });
  });

  it('resolves github tree, release tag, and commit urls', () => {
    expect(resolveInstallSource('https://github.com/owner/repo/tree/release%231')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'branch', value: 'release#1' },
    });
    expect(resolveInstallSource('https://github.com/owner/repo/releases/tag/v1.2.3')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'tag', value: 'v1.2.3' },
    });
    expect(resolveInstallSource('https://github.com/owner/repo/commit/abc1234')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'sha', value: 'abc1234' },
    });
  });

  it('rejects relative paths', () => {
    expect(() => resolveInstallSource('./plugin')).toThrow('absolute path');
  });
});
