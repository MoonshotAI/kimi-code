import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveLegacySourceHome, sameLegacyPath } from '#/migration/legacy-source';

const HOME = '/home/user';
const CWD = '/work/project';

describe('resolveLegacySourceHome', () => {
  it('defaults to ~/.kimi when KIMI_SHARE_DIR is unset', () => {
    const r = resolveLegacySourceHome({}, HOME, CWD);
    expect(r).toEqual({ sourceHome: join(HOME, '.kimi'), origin: 'default' });
  });

  it('defaults to ~/.kimi when KIMI_SHARE_DIR is empty or blank', () => {
    expect(resolveLegacySourceHome({ KIMI_SHARE_DIR: '' }, HOME, CWD).origin).toBe('default');
    expect(resolveLegacySourceHome({ KIMI_SHARE_DIR: '   ' }, HOME, CWD).origin).toBe('default');
  });

  it('uses an absolute KIMI_SHARE_DIR verbatim', () => {
    const r = resolveLegacySourceHome({ KIMI_SHARE_DIR: '/data/kimi' }, HOME, CWD);
    expect(r.sourceHome).toBe('/data/kimi');
    expect(r.origin).toBe('share-dir');
  });

  it('resolves a relative KIMI_SHARE_DIR against the process CWD (old-CLI rule)', () => {
    const r = resolveLegacySourceHome({ KIMI_SHARE_DIR: 'relative/kimi' }, HOME, CWD);
    expect(r.sourceHome).toBe(join(CWD, 'relative', 'kimi'));
    expect(r.origin).toBe('share-dir');
  });

  it('does not expand ~ in KIMI_SHARE_DIR (old-CLI rule)', () => {
    const r = resolveLegacySourceHome({ KIMI_SHARE_DIR: '~/custom' }, HOME, CWD);
    expect(r.sourceHome).toBe(join(CWD, '~/custom'));
  });

  it('resolves skills from ~/.kimi when the share dir is redirected', () => {
    const r = resolveLegacySourceHome({ KIMI_SHARE_DIR: '/data/kimi' }, HOME, CWD);
    expect(r.skillsSourceHome).toBe(join(HOME, '.kimi'));
  });

  it('keeps a single source when KIMI_SHARE_DIR points at ~/.kimi itself', () => {
    const r = resolveLegacySourceHome({ KIMI_SHARE_DIR: join(HOME, '.kimi') }, HOME, CWD);
    expect(r.skillsSourceHome).toBeUndefined();
  });
});

describe('sameLegacyPath', () => {
  it('matches identical and redundant forms', () => {
    expect(sameLegacyPath('/a/b', '/a/b')).toBe(true);
    expect(sameLegacyPath('/a/b/', '/a/b')).toBe(true);
    expect(sameLegacyPath('/a/./b', '/a/b')).toBe(true);
  });

  it('rejects different paths', () => {
    expect(sameLegacyPath('/a/b', '/a/c')).toBe(false);
  });
});
