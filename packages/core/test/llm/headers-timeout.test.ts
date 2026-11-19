import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLlmHeadersTimeoutFetch,
  getLlmHeadersTimeoutDispatcher,
  LLM_HEADERS_TIMEOUT_ENV,
  resolveLlmHeadersTimeoutMs,
} from '#/llm/transport/headers-timeout';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM headers timeout', () => {
  it('as an API consumer, I want positive bounded header timeouts accepted and invalid values rejected', () => {
    expect(resolveLlmHeadersTimeoutMs({})).toBeUndefined();
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: '' })).toBeUndefined();
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: '45000' })).toBe(45_000);
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: ' 1 ' })).toBe(1);
    for (const value of ['abc', '0', '-1', '1.5', '3000000000']) {
      expect(() => resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: value }))
        .toThrow(LLM_HEADERS_TIMEOUT_ENV);
    }
  });

  it('as an API consumer, I want a dispatcher added only when header timeouts are enabled', async () => {
    const fetchStub = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response('ok'));
    vi.stubGlobal('fetch', fetchStub);

    await createLlmHeadersTimeoutFetch({})('https://example.test');
    expect(fetchStub.mock.calls[0]?.[1]).toBeUndefined();

    await createLlmHeadersTimeoutFetch({ [LLM_HEADERS_TIMEOUT_ENV]: '45000' })(
      'https://example.test',
      { method: 'POST' },
    );
    expect(fetchStub.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      dispatcher: expect.any(Object),
    });
  });

  it('as an API consumer, I want HTTP proxies supported while SOCKS and invalid proxies keep the default dispatcher', () => {
    expect(getLlmHeadersTimeoutDispatcher(45_000, {
      HTTP_PROXY: 'http://127.0.0.1:3128',
      no_proxy: 'localhost',
    })).toBeDefined();
    expect(getLlmHeadersTimeoutDispatcher(45_000, {
      ALL_PROXY: 'socks5://127.0.0.1:1080',
    })).toBeUndefined();
    expect(getLlmHeadersTimeoutDispatcher(45_000, {
      HTTP_PROXY: 'not-a-url',
    })).toBeUndefined();
  });
});
