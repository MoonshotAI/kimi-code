import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGitlabSource } from '../../src/plugin/gitlab-resolver';

describe('resolveGitlabSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds an archive URL directly for an explicit ref', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      resolveGitlabSource({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/plugins/sample',
        ref: { kind: 'tag', value: 'release#1' },
      }),
    ).resolves.toEqual({
      tarballUrl:
        'https://gitlab.example.com/api/v4/projects/team%2Fplugins%2Fsample/repository/archive.zip?sha=release%231&ref_type=tags',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('installs the latest release for a bare repository URL', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v1.2.3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(
      resolveGitlabSource({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/sample',
      }),
    ).resolves.toEqual({
      tarballUrl:
        'https://gitlab.example.com/api/v4/projects/team%2Fsample/repository/archive.zip?sha=v1.2.3&ref_type=tags',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/team%2Fsample/releases/permalink/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to the default branch when the project has no release', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(
      resolveGitlabSource({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/sample',
      }),
    ).resolves.toEqual({
      tarballUrl:
        'https://gitlab.example.com/api/v4/projects/team%2Fsample/repository/archive.zip',
    });
  });

  it('reports an unexpected latest-release lookup failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503, statusText: 'Unavailable' })),
    );

    await expect(
      resolveGitlabSource({
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'team/sample',
      }),
    ).rejects.toThrow('HTTP 503 Unavailable');
  });
});
