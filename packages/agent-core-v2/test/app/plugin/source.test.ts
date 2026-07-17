/**
 * Scenario: plugin installation source classification from paths and repository URLs.
 * Responsibilities: distinguish local, zip, GitHub, and GitLab sources and preserve refs.
 * Wiring: pure source resolver with no external collaborators or stubbed boundaries.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/plugin/source.test.ts
 */

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

  it('recognizes a bare GitLab.com URL with nested groups', () => {
    expect(resolveInstallSource('https://gitlab.com/team/plugins/sample')).toEqual({
      kind: 'gitlab',
      baseUrl: 'https://gitlab.com',
      projectPath: 'team/plugins/sample',
    });
  });

  it('recognizes a tree ref on a self-managed GitLab hostname', () => {
    expect(resolveInstallSource('https://gitlab.example.com/team/sample/-/tree/main')).toEqual({
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'team/sample',
      ref: { kind: 'branch', value: 'main' },
    });
  });

  it('recognizes a GitLab release URL as a tag ref', () => {
    expect(
      resolveInstallSource('https://gitlab.example.com/team/sample/-/releases/v1.2.3'),
    ).toEqual({
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'team/sample',
      ref: { kind: 'tag', value: 'v1.2.3' },
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

  it('uses a .git suffix to recognize an arbitrary self-managed hostname', () => {
    expect(resolveInstallSource('https://code.example.com/team/sample.git')).toEqual({
      kind: 'gitlab',
      baseUrl: 'https://code.example.com',
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

  it('rejects relative paths', () => {
    expect(() => resolveInstallSource('./plugin')).toThrow('absolute path');
  });
});
