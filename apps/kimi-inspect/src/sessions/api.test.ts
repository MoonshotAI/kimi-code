/**
 * Tests for the v2 session list REST client (`GET /api/v2/sessions`): query
 * string serialization, envelope-free payload parsing, and error mapping.
 */

import { describe, expect, it } from 'vitest';

import { fetchV2SessionsPage } from './api';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, statusText: 'ERR', json: async () => body };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const pageData = {
  items: [
    {
      id: 's1',
      workspace: { id: 'ws1', cwd: '/tmp/proj' },
      meta: {
        title: '重构会话',
        last_prompt: null,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        archived: false,
      },
      activity: { status: 'running' },
      git: {
        branch: 'main',
        pull_request: { number: 12, state: 'draft', url: 'https://example.com/pr/12' },
      },
    },
    {
      id: 's2',
      workspace: { id: 'ws2', cwd: null },
      meta: {
        title: null,
        last_prompt: 'hello',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_050_000,
        archived: true,
      },
      activity: { status: 'idle' },
    },
    // Malformed entries are dropped, not fatal.
    { id: 42 },
  ],
  has_more: true,
  next_page_token: 'tok-next',
};

describe('fetchV2SessionsPage', () => {
  it('serializes filters as repeated query params and maps items to camelCase', async () => {
    const { calls, fetchImpl } = fakeFetch(200, pageData);
    const page = await fetchV2SessionsPage({
      baseUrl: 'http://h:1',
      token: 'tok',
      workspaceIds: ['ws1', 'ws2'],
      statuses: ['approval', 'question'],
      updatedAfter: 1_700_000_000_000,
      archived: 'all',
      sort: 'meta.created_at_desc',
      includeGit: true,
      pageSize: 20,
      pageToken: 'tok-prev',
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('http://h:1/api/v2/sessions');
    expect(url.searchParams.getAll('workspace.id')).toEqual(['ws1', 'ws2']);
    expect(url.searchParams.getAll('activity.status')).toEqual(['approval', 'question']);
    expect(url.searchParams.get('meta.updated_after')).toBe('1700000000000');
    expect(url.searchParams.get('meta.archived')).toBe('all');
    expect(url.searchParams.get('sort')).toBe('meta.created_at_desc');
    expect(url.searchParams.get('include')).toBe('git');
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(url.searchParams.get('page_token')).toBe('tok-prev');
    expect(calls[0]!.init?.headers).toEqual({ authorization: 'Bearer tok' });

    expect(page.items).toHaveLength(2);
    const first = page.items[0]!;
    expect(first.id).toBe('s1');
    expect(first.workspace).toEqual({ id: 'ws1', cwd: '/tmp/proj' });
    expect(first.meta).toEqual({
      title: '重构会话',
      lastPrompt: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      archived: false,
    });
    expect(first.activity.status).toBe('running');
    // Draft PRs are not in the v2 enum; an unknown state degrades to null.
    expect(first.git?.branch).toBe('main');
    expect(first.git?.pullRequest).toBeNull();
    const second = page.items[1]!;
    expect(second.meta.title).toBeNull();
    expect(second.meta.lastPrompt).toBe('hello');
    expect(second.git).toBeUndefined();
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe('tok-next');
  });

  it('omits the query string and authorization header when nothing is set', async () => {
    const { calls, fetchImpl } = fakeFetch(200, pageData);
    await fetchV2SessionsPage({ baseUrl: 'http://h:1', fetchImpl });
    expect(calls[0]!.url).toBe('http://h:1/api/v2/sessions');
    expect(calls[0]!.init?.headers).toEqual({});
  });

  it('parses a well-formed pull_request', async () => {
    const { fetchImpl } = fakeFetch(200, {
      ...pageData,
      items: [
        {
          ...pageData.items[0],
          git: {
            branch: 'feat/x',
            pull_request: { number: 7, state: 'open', url: 'https://example.com/pr/7' },
          },
        },
      ],
    });
    const page = await fetchV2SessionsPage({ baseUrl: 'http://h:1', includeGit: true, fetchImpl });
    expect(page.items[0]!.git?.pullRequest).toEqual({
      number: 7,
      state: 'open',
      url: 'https://example.com/pr/7',
    });
  });

  it('throws the server error code/message on a non-2xx response', async () => {
    const { fetchImpl } = fakeFetch(409, {
      error: { code: 'page_token_mismatch', message: 'page_token is corrupted' },
    });
    await expect(
      fetchV2SessionsPage({ baseUrl: 'http://h:1', pageToken: 'bad', fetchImpl }),
    ).rejects.toThrow(/page_token_mismatch.*page_token is corrupted/);
  });

  it('falls back to the HTTP status when the error body is malformed', async () => {
    const { fetchImpl } = fakeFetch(500, null);
    await expect(fetchV2SessionsPage({ baseUrl: 'http://h:1', fetchImpl })).rejects.toThrow(
      /http_500/,
    );
  });

  it('throws on a malformed 2xx payload', async () => {
    const { fetchImpl } = fakeFetch(200, { has_more: false });
    await expect(fetchV2SessionsPage({ baseUrl: 'http://h:1', fetchImpl })).rejects.toThrow(
      /unexpected response shape/,
    );
  });
});
