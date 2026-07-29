/**
 * Tests for the global search REST client (`POST /api/v1/search`): request
 * serialization, envelope unwrapping, and hit parsing.
 */

import { describe, expect, it } from 'vitest';

import { fetchSearchPage } from './api';

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

const pageData = {
  items: [
    {
      session_id: 's1',
      workspace_id: 'ws',
      session_title: '搜索重构',
      agent_id: 'main',
      role: 'assistant',
      snippet: 'Here is the apple guide.',
      time: 1_700_000_000_000,
      turn: 3,
      step_id: 't3.2',
      score: 1.5,
    },
    {
      session_id: 's2',
      workspace_id: 'ws',
      session_title: 'title doc',
      agent_id: '',
      role: 'title',
      snippet: '苹果询价',
      time: 1_700_000_100_000,
      score: 0.9,
    },
    // Malformed entries are dropped, not fatal.
    { session_id: 42 },
  ],
  has_more: true,
  page_token: 'tok-next',
  index_state: { state: 'ready', indexed_sessions: 2, total_sessions: 2, documents: 10 },
};

describe('fetchSearchPage', () => {
  it('posts the snake_case body with bearer auth and maps hits to camelCase', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(pageData));
    const page = await fetchSearchPage({
      baseUrl: 'http://h:1',
      token: 'tok',
      query: '苹果',
      role: 'assistant',
      sort: 'time_desc',
      pageSize: 20,
      pageToken: 'tok-prev',
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://h:1/api/v1/search');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      query: '苹果',
      role: 'assistant',
      sort: 'time_desc',
      page_size: 20,
      page_token: 'tok-prev',
    });

    expect(page.items).toHaveLength(2);
    const assistant = page.items[0]!;
    expect(assistant.sessionId).toBe('s1');
    expect(assistant.role).toBe('assistant');
    expect(assistant.turn).toBe(3);
    expect(assistant.stepId).toBe('t3.2');
    const title = page.items[1]!;
    expect(title.agentId).toBe('');
    expect(title.turn).toBeUndefined();
    expect(title.stepId).toBeUndefined();
    expect(page.hasMore).toBe(true);
    expect(page.pageToken).toBe('tok-next');
    expect(page.indexState).toEqual({
      state: 'ready',
      indexedSessions: 2,
      totalSessions: 2,
      documents: 10,
    });
  });

  it('omits the authorization header when no token is configured', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(pageData));
    await fetchSearchPage({ baseUrl: 'http://h:1', query: '苹果', fetchImpl });
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('serializes mode into the body and parses incomplete: candidate_cap', async () => {
    const { calls, fetchImpl } = fakeFetch(
      okEnvelope({ ...pageData, has_more: false, incomplete: 'candidate_cap' }),
    );
    const page = await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: 'C++',
      mode: 'literal',
      fetchImpl,
    });

    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      query: 'C++',
      mode: 'literal',
    });
    expect(page.incomplete).toBe('candidate_cap');
  });

  it('leaves incomplete undefined for absent or unexpected values', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope(pageData));
    const page = await fetchSearchPage({ baseUrl: 'http://h:1', query: '苹果', fetchImpl });
    expect(page.incomplete).toBeUndefined();

    const { fetchImpl: fetchImpl2 } = fakeFetch(
      okEnvelope({ ...pageData, incomplete: 'something_else' }),
    );
    const page2 = await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: '苹果',
      fetchImpl: fetchImpl2,
    });
    expect(page2.incomplete).toBeUndefined();
  });

  it('serializes container into the body (session only, and session + agent)', async () => {
    const { calls, fetchImpl } = fakeFetch(okEnvelope(pageData));
    await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: '苹果',
      container: { sessionId: 's1' },
      fetchImpl,
    });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      query: '苹果',
      container: { session_id: 's1' },
    });

    const { calls: calls2, fetchImpl: fetchImpl2 } = fakeFetch(okEnvelope(pageData));
    await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: '苹果',
      container: { sessionId: 's1', agentId: 'main' },
      fetchImpl: fetchImpl2,
    });
    expect(JSON.parse(calls2[0]!.init?.body as string)).toEqual({
      query: '苹果',
      container: { session_id: 's1', agent_id: 'main' },
    });
  });

  it('parses source: live and source: index', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ ...pageData, source: 'live' }));
    const page = await fetchSearchPage({ baseUrl: 'http://h:1', query: '苹果', fetchImpl });
    expect(page.source).toBe('live');

    const { fetchImpl: fetchImpl2 } = fakeFetch(okEnvelope({ ...pageData, source: 'index' }));
    const page2 = await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: '苹果',
      fetchImpl: fetchImpl2,
    });
    expect(page2.source).toBe('index');
  });

  it('leaves source undefined for absent or unknown values', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope(pageData));
    const page = await fetchSearchPage({ baseUrl: 'http://h:1', query: '苹果', fetchImpl });
    expect(page.source).toBeUndefined();

    const { fetchImpl: fetchImpl2 } = fakeFetch(okEnvelope({ ...pageData, source: 'whatever' }));
    const page2 = await fetchSearchPage({
      baseUrl: 'http://h:1',
      query: '苹果',
      fetchImpl: fetchImpl2,
    });
    expect(page2.source).toBeUndefined();
  });

  it('throws on a non-zero envelope code', async () => {
    const { fetchImpl } = fakeFetch({
      code: 40001,
      msg: 'query must be a non-empty string',
      data: null,
    });
    await expect(fetchSearchPage({ baseUrl: 'http://h:1', query: '', fetchImpl })).rejects.toThrow(
      /40001/,
    );
  });

  it('throws on a malformed payload', async () => {
    const { fetchImpl } = fakeFetch(okEnvelope({ has_more: false }));
    await expect(fetchSearchPage({ baseUrl: 'http://h:1', query: 'x', fetchImpl })).rejects.toThrow(
      /unexpected response shape/,
    );
  });
});
