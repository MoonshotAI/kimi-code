import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGitlabSource } from '#/app/plugin/gitlab-resolver';

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

  it('uses the latest release or falls back to the default branch', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const source = {
      kind: 'gitlab' as const,
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'team/sample',
    };

    await expect(resolveGitlabSource(source)).resolves.toEqual({
      tarballUrl:
        'https://gitlab.example.com/api/v4/projects/team%2Fsample/repository/archive.zip?sha=v1.2.3&ref_type=tags',
    });
    await expect(resolveGitlabSource(source)).resolves.toEqual({
      tarballUrl:
        'https://gitlab.example.com/api/v4/projects/team%2Fsample/repository/archive.zip',
    });
  });
});
