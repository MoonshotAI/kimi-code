/**
 * Scenario: GitLab plugin source resolution through instance API endpoints.
 * Responsibilities: build archive URLs for explicit refs, select the latest
 * release, and fall back to the default branch when no release exists.
 * Wiring: real resolver with only the external `fetch` boundary stubbed.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/plugin/gitlab-resolver.test.ts
 */

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

  it('uses the latest release for a bare repository URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }));
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
});
