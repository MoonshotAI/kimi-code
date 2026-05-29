import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGithubSource } from '../../src/plugin/github-resolver';

const REAL_FETCH = globalThis.fetch;

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  statusText?: string;
}

function mockSequence(queue: MockResponse[]): void {
  const remaining = [...queue];
  globalThis.fetch = vi.fn(async () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error('mockFetch: queue exhausted');
    const body = next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status,
      statusText: next.statusText,
      headers: next.headers,
    }) as unknown as Response;
  }) as typeof fetch;
}

describe('resolveGithubSource', () => {
  beforeEach(() => {
    globalThis.fetch = REAL_FETCH;
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  it('explicit branch-kind ref uses codeload short form (matches /tree/ semantics)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'wbxl2000',
      repo: 'superpowers',
      ref: { kind: 'branch', value: 'main' },
    });

    expect(result).toEqual({
      tarballUrl: 'https://codeload.github.com/wbxl2000/superpowers/zip/main',
      displayVersion: 'main',
      ref: { kind: 'branch', value: 'main' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('branch-kind ref carrying a tag value (e.g. /tree/v5.1.0) still resolves via short form', async () => {
    // Reproduces the P1 reviewer caught: parser cannot distinguish branch from
    // tag in `/tree/<ref>`, but codeload's short form resolves either.
    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'obra',
      repo: 'superpowers',
      ref: { kind: 'branch', value: 'v5.1.0' },
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/obra/superpowers/zip/v5.1.0',
    );
  });

  it('explicit tag ref uses /refs/tags/ path', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'obra',
      repo: 'superpowers',
      ref: { kind: 'tag', value: 'v5.1.0' },
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/obra/superpowers/zip/refs/tags/v5.1.0',
    );
  });

  it('explicit sha ref uses raw sha in the path', async () => {
    const sha = '45b441d62b81b5f27d3bfd8700e04436cd4de5b3';
    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'wbxl2000',
      repo: 'superpowers',
      ref: { kind: 'sha', value: sha },
    });

    expect(result.tarballUrl).toBe(
      `https://codeload.github.com/wbxl2000/superpowers/zip/${sha}`,
    );
  });

  it('encodes URL-reserved characters in tag refs so codeload sees the full ref (P2 regression)', async () => {
    // Git allows `#` in tag names. Without encoding, `#1` becomes a URL
    // fragment and codeload only sees `refs/tags/release`.
    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'tag', value: 'release#1' },
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/owner/repo/zip/refs/tags/release%231',
    );
    // Sanity: parsing this URL should report the encoded form in the path,
    // no fragment leakage.
    const parsed = new URL(result.tarballUrl);
    expect(parsed.hash).toBe('');
    expect(parsed.pathname.endsWith('release%231')).toBe(true);
  });

  it('encodes URL-reserved characters in branch refs too', async () => {
    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'branch', value: 'feat#1' },
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/owner/repo/zip/feat%231',
    );
  });

  it('preserves `/` as path separator when encoding multi-segment refs', async () => {
    // A branch named `feat/has space` must encode the space but keep the `/`.
    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'branch', value: 'feat/has space' },
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/owner/repo/zip/feat/has%20space',
    );
  });

  it('bare URL: 302 with /releases/tag/X resolves to that tag', async () => {
    mockSequence([
      {
        status: 302,
        headers: { location: 'https://github.com/obra/superpowers/releases/tag/v5.1.0' },
      },
    ]);

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'obra',
      repo: 'superpowers',
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/obra/superpowers/zip/refs/tags/v5.1.0',
    );
    expect(result.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(result.displayVersion).toBe('v5.1.0');
  });

  it('bare URL: 302 with url-encoded tag in path decodes correctly', async () => {
    mockSequence([
      {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases/tag/feat%2Frelease' },
      },
    ]);

    const result = await resolveGithubSource({ kind: 'github', owner: 'o', repo: 'r' });
    expect(result.ref).toEqual({ kind: 'tag', value: 'feat/release' });
  });

  it('bare URL: latest release tag with `#` round-trips through to a properly encoded codeload URL (P2 regression)', async () => {
    // GitHub redirects with the tag percent-encoded. We decode for storage,
    // then must re-encode when building the codeload URL.
    mockSequence([
      {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases/tag/release%231' },
      },
    ]);

    const result = await resolveGithubSource({ kind: 'github', owner: 'o', repo: 'r' });

    expect(result.ref).toEqual({ kind: 'tag', value: 'release#1' });
    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/o/r/zip/refs/tags/release%231',
    );
    // Sanity: no fragment hijacking.
    expect(new URL(result.tarballUrl).hash).toBe('');
  });

  it('bare URL: 404 from /releases/latest falls back to codeload HEAD', async () => {
    mockSequence([
      { status: 404 }, // releases/latest
      { status: 200 }, // codeload HEAD probe
    ]);

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'wbxl2000',
      repo: 'superpowers',
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/wbxl2000/superpowers/zip/HEAD',
    );
    expect(result.displayVersion).toBe('HEAD');
    expect(result.ref).toEqual({ kind: 'branch', value: 'HEAD' });
  });

  it('bare URL: 302 to /releases (fork with inherited tags but no own release) falls back to HEAD', async () => {
    mockSequence([
      {
        status: 302,
        headers: { location: 'https://github.com/wbxl2000/superpowers/releases' },
      },
      { status: 200 }, // codeload HEAD probe
    ]);

    const result = await resolveGithubSource({
      kind: 'github',
      owner: 'wbxl2000',
      repo: 'superpowers',
    });

    expect(result.tarballUrl).toBe(
      'https://codeload.github.com/wbxl2000/superpowers/zip/HEAD',
    );
    expect(result.ref).toEqual({ kind: 'branch', value: 'HEAD' });
  });

  it('bare URL: 404 on both /releases/latest and codeload HEAD ⇒ repo not found', async () => {
    mockSequence([
      { status: 404 }, // releases/latest
      { status: 404 }, // codeload HEAD probe
    ]);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'nobody', repo: 'nothing' }),
    ).rejects.toThrow(/`nobody\/nothing` not found or not accessible/);
  });

  it('bare URL: 5xx on /releases/latest throws instead of silently falling back', async () => {
    mockSequence([
      { status: 503, statusText: 'Service Unavailable' },
    ]);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' }),
    ).rejects.toThrow(/Could not look up latest release.*HTTP 503/);
  });

  it('bare URL: 429 (rate-limit-style) on /releases/latest throws, not falls back', async () => {
    mockSequence([
      { status: 429, statusText: 'Too Many Requests' },
    ]);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' }),
    ).rejects.toThrow(/Could not look up latest release.*HTTP 429/);
  });

  it('bare URL: 403 (WAF/abuse-detection-style) on /releases/latest throws, not falls back', async () => {
    mockSequence([
      { status: 403, statusText: 'Forbidden' },
    ]);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' }),
    ).rejects.toThrow(/Could not look up latest release.*HTTP 403/);
  });

  it('release-lookup error message hints at the /tree/<ref> escape hatch', async () => {
    mockSequence([
      { status: 502, statusText: 'Bad Gateway' },
    ]);

    await expect(
      resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' }),
    ).rejects.toThrow(/\/tree\/<branch\|tag\|sha>/);
  });

  it('does not call api.github.com at all on bare URL', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push(url);
      if (url.includes('github.com') && url.includes('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/obra/superpowers/releases/tag/v5.1.0' },
        }) as unknown as Response;
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    await resolveGithubSource({ kind: 'github', owner: 'obra', repo: 'superpowers' });
    expect(calls.every((u) => !u.startsWith('https://api.github.com'))).toBe(true);
  });
});
