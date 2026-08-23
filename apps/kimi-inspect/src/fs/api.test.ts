import { describe, expect, it } from 'vitest';

import { fetchWorkspaceFsSuggest } from './api';

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

describe('fetchWorkspaceFsSuggest', () => {
  it('posts the workspace suggestion request and maps items', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(resultData));
    const result = await fetchWorkspaceFsSuggest({
      baseUrl: 'http://h:1/',
      token: 'tok',
      workspace: 'ws-1',
      query: 'apps/de',
      limit: 20,
      followGitignore: true,
      showHidden: false,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['dist/**'],
      runtimeId: 'local',
      fetchImpl,
    });

    expect(calls[0]!.url).toBe('http://h:1/api/v1/workspace/fs:suggest');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      workspace: 'ws-1',
      query: 'apps/de',
      limit: 20,
      follow_gitignore: true,
      show_hidden: false,
      include_globs: ['**/*.ts'],
      exclude_globs: ['dist/**'],
      runtime_id: 'local',
    });
    expect(result.items).toEqual([
      {
        path: 'apps/desktop',
        name: 'desktop',
        kind: 'directory',
        score: 0.9,
        matchPositions: [5, 6],
      },
      {
        path: 'README.md',
        name: 'README.md',
        kind: 'file',
        score: 0.8,
        matchPositions: [0, 1],
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  it('omits optional fields and authorization when not configured', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope({ items: [], truncated: false }));
    await fetchWorkspaceFsSuggest({
      baseUrl: 'http://h:1',
      workspace: '/tmp/workspace',
      query: '',
      fetchImpl,
    });
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      workspace: '/tmp/workspace',
      query: '',
    });
  });

  it('throws on a non-zero envelope code', async () => {
    const { fetchImpl } = fakeFetch({ code: 40410, msg: 'workspace missing', data: null });
    await expect(
      fetchWorkspaceFsSuggest({
        baseUrl: 'http://h:1',
        workspace: 'missing',
        query: 'x',
        fetchImpl,
      }),
    ).rejects.toThrow(/40410/);
  });

  it('throws on a malformed payload', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ truncated: false }));
    await expect(
      fetchWorkspaceFsSuggest({ baseUrl: 'http://h:1', workspace: 'ws', query: 'x', fetchImpl }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});
