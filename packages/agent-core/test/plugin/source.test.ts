import { describe, expect, it } from 'vitest';

import { resolveInstallSource } from '../../src/plugin/source';

describe('resolveInstallSource', () => {
  it('recognizes https:// as zip-url', () => {
    const result = resolveInstallSource('https://example.com/plugin.zip');
    expect(result).toEqual({ kind: 'zip-url', path: 'https://example.com/plugin.zip' });
  });

  it('recognizes http:// as zip-url', () => {
    const result = resolveInstallSource('http://example.com/plugin.zip');
    expect(result).toEqual({ kind: 'zip-url', path: 'http://example.com/plugin.zip' });
  });

  it('recognizes absolute path as local-path', () => {
    const result = resolveInstallSource('/home/user/plugin');
    expect(result).toEqual({ kind: 'local-path', path: '/home/user/plugin' });
  });

  it('trims whitespace from local paths', () => {
    const result = resolveInstallSource('  /home/user/plugin  ');
    expect(result).toEqual({ kind: 'local-path', path: '/home/user/plugin' });
  });

  it('throws for relative local paths', () => {
    expect(() => resolveInstallSource('relative/path')).toThrow(/absolute path/i);
  });

  it('throws for empty string', () => {
    expect(() => resolveInstallSource('')).toThrow(/absolute path/i);
  });

  describe('GitHub URL recognition', () => {
    it('recognizes bare github URL', () => {
      const result = resolveInstallSource('https://github.com/wbxl2000/superpowers');
      expect(result).toEqual({
        kind: 'github',
        owner: 'wbxl2000',
        repo: 'superpowers',
      });
    });

    it('recognizes www.github.com as a synonym', () => {
      const result = resolveInstallSource('https://www.github.com/wbxl2000/superpowers');
      expect(result).toEqual({
        kind: 'github',
        owner: 'wbxl2000',
        repo: 'superpowers',
      });
    });

    it('strips trailing slash on bare URL', () => {
      const result = resolveInstallSource('https://github.com/wbxl2000/superpowers/');
      expect(result).toEqual({
        kind: 'github',
        owner: 'wbxl2000',
        repo: 'superpowers',
      });
    });

    it('recognizes /tree/<branch>', () => {
      const result = resolveInstallSource('https://github.com/obra/superpowers/tree/main');
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: { kind: 'branch', value: 'main' },
      });
    });

    it('recognizes /tree/<tag-like-value> as branch (cannot distinguish without API)', () => {
      const result = resolveInstallSource('https://github.com/obra/superpowers/tree/v5.1.0');
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: { kind: 'branch', value: 'v5.1.0' },
      });
    });

    it('recognizes /tree/<short-sha> as sha', () => {
      const result = resolveInstallSource('https://github.com/obra/superpowers/tree/45b441d');
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: { kind: 'sha', value: '45b441d' },
      });
    });

    it('recognizes /tree/<full-sha> as sha', () => {
      const sha = '45b441d62b81b5f27d3bfd8700e04436cd4de5b3';
      const result = resolveInstallSource(`https://github.com/obra/superpowers/tree/${sha}`);
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: { kind: 'sha', value: sha },
      });
    });

    it('preserves slashes inside branch names under /tree/', () => {
      const result = resolveInstallSource('https://github.com/owner/repo/tree/feat/foo-bar');
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'feat/foo-bar' },
      });
    });

    it('strips trailing slash on /tree/', () => {
      const result = resolveInstallSource('https://github.com/owner/repo/tree/main/');
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'main' },
      });
    });

    it('drops query and fragment from /tree/<ref>', () => {
      const result = resolveInstallSource('https://github.com/owner/repo/tree/main?x=1#y');
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'main' },
      });
    });

    it('accepts /releases/tag/<tag> as a tag-kind ref', () => {
      const result = resolveInstallSource(
        'https://github.com/obra/superpowers/releases/tag/v5.1.0',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: { kind: 'tag', value: 'v5.1.0' },
      });
    });

    it('accepts /commit/<sha> as a sha-kind ref', () => {
      const result = resolveInstallSource(
        'https://github.com/obra/superpowers/commit/45b441d62b81b5f27d3bfd8700e04436cd4de5b3',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'obra',
        repo: 'superpowers',
        ref: {
          kind: 'sha',
          value: '45b441d62b81b5f27d3bfd8700e04436cd4de5b3',
        },
      });
    });

    it('does not recognize /archive/refs/tags/X.zip as github source (falls through to zip-url)', () => {
      const url = 'https://github.com/obra/superpowers/archive/refs/tags/v5.1.0.zip';
      const result = resolveInstallSource(url);
      expect(result).toEqual({ kind: 'zip-url', path: url });
    });

    it('does not recognize /archive/refs/heads/main.zip as github source (falls through to zip-url)', () => {
      const url = 'https://github.com/obra/superpowers/archive/refs/heads/main.zip';
      const result = resolveInstallSource(url);
      expect(result).toEqual({ kind: 'zip-url', path: url });
    });

    it('treats http:// (non-https) github URL as plain zip-url', () => {
      const url = 'http://github.com/wbxl2000/superpowers';
      const result = resolveInstallSource(url);
      expect(result).toEqual({ kind: 'zip-url', path: url });
    });

    it('percent-decodes %23 in /releases/tag/ so storage is human-readable', () => {
      // Git allows `#` in tag names. GitHub UI URLs encode it as %23.
      const result = resolveInstallSource(
        'https://github.com/owner/repo/releases/tag/release%231',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'tag', value: 'release#1' },
      });
    });

    it('percent-decodes /tree/<encoded> ref values', () => {
      const result = resolveInstallSource(
        'https://github.com/owner/repo/tree/feat%231',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'feat#1' },
      });
    });

    it('preserves slashes when decoding multi-segment refs (e.g. feat/foo with %20 in middle)', () => {
      const result = resolveInstallSource(
        'https://github.com/owner/repo/tree/feat/has%20space',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'feat/has space' },
      });
    });

    it('keeps malformed percent-encoding verbatim instead of crashing', () => {
      // `%ZZ` is invalid; decodeURIComponent throws. Don't propagate.
      const result = resolveInstallSource(
        'https://github.com/owner/repo/tree/bad%ZZname',
      );
      expect(result).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'bad%ZZname' },
      });
    });
  });

  describe('GitLab URL recognition', () => {
    it('recognizes a bare GitLab.com URL with nested groups', () => {
      expect(resolveInstallSource('https://gitlab.com/example/plugins/sample')).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.com',
        projectPath: 'example/plugins/sample',
      });
    });

    it('recognizes a self-managed GitLab host', () => {
      expect(resolveInstallSource('https://gitlab.example.com/team/sample')).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/sample',
      });
    });

    it.each(['mygitlab.example.com', 'gitlab01.example.com'])(
      'recognizes a self-managed hostname containing GitLab: %s',
      (hostname) => {
        expect(resolveInstallSource(`https://${hostname}/team/sample`)).toEqual({
          kind: 'gitlab',
          baseUrl: `https://${hostname}`,
          projectPath: 'team/sample',
        });
      },
    );

    it('uses a .git suffix to recognize an arbitrary self-managed host', () => {
      expect(resolveInstallSource('https://code.example.com/team/sample.git')).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://code.example.com',
        projectPath: 'team/sample',
      });
    });

    it('recognizes tree, release, and commit URLs', () => {
      expect(
        resolveInstallSource('https://code.example.com/team/sample/-/tree/feat%231'),
      ).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://code.example.com',
        projectPath: 'team/sample',
        ref: { kind: 'branch', value: 'feat#1' },
      });
      expect(
        resolveInstallSource('https://code.example.com/team/sample/-/releases/v1.2.3'),
      ).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://code.example.com',
        projectPath: 'team/sample',
        ref: { kind: 'tag', value: 'v1.2.3' },
      });
      expect(
        resolveInstallSource('https://code.example.com/team/sample/-/commit/abc1234'),
      ).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://code.example.com',
        projectPath: 'team/sample',
        ref: { kind: 'sha', value: 'abc1234' },
      });
    });

    it('treats the latest-release permalink as a bare repository URL', () => {
      expect(
        resolveInstallSource(
          'https://gitlab.example.com/team/sample/-/releases/permalink/latest',
        ),
      ).toEqual({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/sample',
      });
    });

    it.each([
      [
        'versioned release asset',
        'https://gitlab.example.com/team/sample/-/releases/v1/downloads/plugin.zip',
      ],
      [
        'latest release asset',
        'https://gitlab.example.com/team/sample/-/releases/permalink/latest/downloads/plugin.zip',
      ],
    ])('leaves a %s URL as a zip source', (_description, url) => {
      expect(resolveInstallSource(url)).toEqual({ kind: 'zip-url', path: url });
    });

    it('leaves existing GitLab archive URLs as zip URLs', () => {
      const url =
        'https://gitlab.example.com/team/sample/-/archive/main/sample-main.zip';
      expect(resolveInstallSource(url)).toEqual({ kind: 'zip-url', path: url });
    });
  });
});
