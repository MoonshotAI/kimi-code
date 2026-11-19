import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLlmHeadersTimeoutFetch,
  LLM_HEADERS_TIMEOUT_ENV,
  resolveLlmHeadersTimeoutMs,
} from '#/llm/transport/headers-timeout';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM headers timeout transport', () => {
  it('resolves valid values and rejects invalid or overflowing settings', () => {
    expect(resolveLlmHeadersTimeoutMs({})).toBeUndefined();
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: ' ' })).toBeUndefined();
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: '45000' })).toBe(45_000);
    expect(resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: `${2 ** 31 - 1}` })).toBe(2 ** 31 - 1);

    for (const raw of ['abc', '0', '-1', '1.5', `${2 ** 31}`]) {
      expect(() => resolveLlmHeadersTimeoutMs({ [LLM_HEADERS_TIMEOUT_ENV]: raw })).toThrow(
        LLM_HEADERS_TIMEOUT_ENV,
      );
    }
  });

  it('adds a dispatcher only when headers timeout is enabled and supported', async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchStub);
    expect(createLlmHeadersTimeoutFetch({})).toBe(fetchStub);
    expect(createLlmHeadersTimeoutFetch({
      [LLM_HEADERS_TIMEOUT_ENV]: '45000',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
    })).toBe(fetchStub);

    const direct = createLlmHeadersTimeoutFetch({ [LLM_HEADERS_TIMEOUT_ENV]: '45000' });
    await direct('https://example.test');
    expect(fetchStub.mock.calls[0]?.[1]).toHaveProperty('dispatcher');

    const proxied = createLlmHeadersTimeoutFetch({
      [LLM_HEADERS_TIMEOUT_ENV]: '45000',
      HTTP_PROXY: 'http://127.0.0.1:3128',
    });
    await proxied('https://example.test');
    expect(fetchStub.mock.calls[1]?.[1]).toHaveProperty('dispatcher');
  });
});
