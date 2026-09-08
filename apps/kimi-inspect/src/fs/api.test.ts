import { describe, expect, it } from 'vitest';

import { fetchFsSuggest } from './api';

function okEnvelope(data: unknown) {
  return { code: 0, msg: 'success', data, request_id: 'r1' };
}

function fakeFetch(envelope: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { json: async () => envelope };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const resultData = {
  items: [
    {
      path: 'apps/desktop',
      name: 'desktop',
      kind: 'directory',
      score: 0.9,
      match_positions: [5, 6],
    },
    { path: 'README.md', name: 'README.md', kind: 'file', score: 0.8, match_positions: [0, 1] },
    { path: 'broken' },
  ],
  truncated: true,
};

describe('fetchFsSuggest', () => {
  it('posts the roots suggestion request and maps items', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(resultData));
    const result = await fetchFsSuggest({
      baseUrl: 'http://h:1/',
      token: 'tok',
      roots: ['/repo', '/extra'],
      query: 'apps/de',
      limit: 20,
      followGitignore: false,
      showHidden: true,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['dist/**'],
      runtimeId: 'local',
      fetchImpl,
    });

    expect(calls[0]!.url).toBe('http://h:1/api/v1/fs:suggest');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      roots: ['/repo', '/extra'],
      query: 'apps/de',
      limit: 20,
      follow_gitignore: false,
      show_hidden: true,
      include_globs: ['**/*.ts'],
      exclude_globs: ['dist/**'],
      runtime_id: 'local',
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      path: 'apps/desktop',
      name: 'desktop',
      kind: 'directory',
      score: 0.9,
      matchPositions: [5, 6],
    });
    expect(result.truncated).toBe(true);
  });

  it('omits optional fields and authorization when not configured', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope({ items: [], truncated: false }));
    await fetchFsSuggest({ baseUrl: 'http://h:1', roots: ['/repo'], query: '', fetchImpl });
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      roots: ['/repo'],
      query: '',
    });
  });

  it('throws on a non-zero envelope code', async () => {
    const { fetchImpl } = fakeFetch({ code: 40409, msg: 'root missing', data: null });
    await expect(
      fetchFsSuggest({ baseUrl: 'http://h:1', roots: ['/missing'], query: 'x', fetchImpl }),
    ).rejects.toThrow(/40409/);
  });

  it('throws on a malformed payload', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ truncated: false }));
    await expect(
      fetchFsSuggest({ baseUrl: 'http://h:1', roots: ['/repo'], query: 'x', fetchImpl }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});
