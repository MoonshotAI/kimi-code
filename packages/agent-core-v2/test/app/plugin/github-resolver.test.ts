/**
 * Scenario: GitHub plugin source resolution without the GitHub REST API.
 *
 * Verifies release, branch, tag, SHA, timeout, and commit-feed behavior at the
 * network boundary; `fetch` is stubbed and no real requests are made.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/plugin/github-resolver.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGithubCommitSha, resolveGithubSource } from '#/app/plugin/github-resolver';

describe('resolveGithubSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves explicit refs without network and encodes ref paths', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'owner', repo: 'repo', ref: { kind: 'tag', value: 'release#1' } }),
    ).resolves.toEqual({
      tarballUrl: 'https://codeload.github.com/owner/repo/zip/refs/tags/release%231',
      displayVersion: 'release#1',
      ref: { kind: 'tag', value: 'release#1' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a branch head from the GitHub commit feed', async () => {
    const sha = '1111111111111111111111111111111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id></entry>`),
      ),
    );

    await expect(resolveGithubCommitSha('owner', 'repo', 'feature/demo')).resolves.toBe(sha);
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/owner/repo/commits/feature/demo.atom',
      expect.objectContaining({
        headers: expect.objectContaining({ accept: 'application/atom+xml' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses latest release redirect for bare github urls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'https://github.com/owner/repo/releases/tag/v1.2.3' }),
      }),
    );

    await expect(resolveGithubSource({ kind: 'github', owner: 'owner', repo: 'repo' })).resolves.toEqual({
      tarballUrl: 'https://codeload.github.com/owner/repo/zip/refs/tags/v1.2.3',
      displayVersion: 'v1.2.3',
      ref: { kind: 'tag', value: 'v1.2.3' },
    });
  });

  it('falls back to HEAD when there is no latest release', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 404, ok: false, headers: new Headers() })
        .mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers() }),
    );

    await expect(resolveGithubSource({ kind: 'github', owner: 'owner', repo: 'repo' })).resolves.toEqual({
      tarballUrl: 'https://codeload.github.com/owner/repo/zip/HEAD',
      displayVersion: 'HEAD',
      ref: { kind: 'branch', value: 'HEAD' },
    });
  });

  it('branch-kind ref carrying a tag value (e.g. /tree/v5.1.0) still resolves via short form', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'obra',
      repo: 'superpowers',
      ref: { kind: 'branch', value: 'v5.1.0' },
    });

    expect(result.tarballUrl).toBe('https://codeload.github.com/obra/superpowers/zip/v5.1.0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bare URL: 302 with /releases/tag/X resolves to that tag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({
          location: 'https://github.com/obra/superpowers/releases/tag/v5.1.0',
        }),
      }),
    );

    const result = await resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' });
    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/obra/superpowers/zip/refs/tags/v5.1.0',
    );
    expect(result.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(result.displayVersion).toBe('v5.1.0');
  });

  it('does not call api.github.com on bare URL (API bypass)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        if (url.includes('github.com') && url.includes('/releases/latest')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/obra/superpowers/releases/tag/v5.1.0' },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      }) as typeof fetch,
    );

    await resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' });
    expect(calls.every((u) => !u.startsWith('https://api.github.com'))).toBe(true);
  });

  it('release-lookup error message hints at the /tree/<ref> escape hatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 502, statusText: 'Bad Gateway', headers: new Headers() }),
    );

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' }),
    ).rejects.toThrow(/\/tree\/<branch\|tag\|sha>/);
  });
});
