import { beforeEach, describe, expect, it, vi } from 'vitest';

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
}));

import {
  asProviderModelsFetchRequest,
  fetchProviderModelsViaNet,
} from '../../../src/main/system/provider-models-fetch';

describe('asProviderModelsFetchRequest', () => {
  it('accepts a valid request', () => {
    expect(
      asProviderModelsFetchRequest({
        url: 'https://api.example.com/v1/models',
        headers: { authorization: 'Bearer sk-test' },
        timeoutMs: 15000,
      }),
    ).toEqual({
      url: 'https://api.example.com/v1/models',
      headers: { authorization: 'Bearer sk-test' },
      timeoutMs: 15000,
    });
  });

  it('rejects non-object and invalid-url payloads', () => {
    expect(asProviderModelsFetchRequest(null)).toBeNull();
    expect(asProviderModelsFetchRequest('https://api.example.com')).toBeNull();
    expect(asProviderModelsFetchRequest({})).toBeNull();
    expect(asProviderModelsFetchRequest({ url: '' })).toBeNull();
    expect(asProviderModelsFetchRequest({ url: 'not a url' })).toBeNull();
  });

  it('rejects non-http(s) protocols', () => {
    expect(asProviderModelsFetchRequest({ url: 'file:///etc/passwd' })).toBeNull();
    expect(asProviderModelsFetchRequest({ url: 'ftp://example.com/models' })).toBeNull();
    expect(asProviderModelsFetchRequest({ url: 'app://renderer/index.html' })).toBeNull();
  });

  it('rejects malformed headers', () => {
    expect(asProviderModelsFetchRequest({ url: 'https://a.com', headers: 'Bearer x' })).toBeNull();
    expect(asProviderModelsFetchRequest({ url: 'https://a.com', headers: { a: 1 } })).toBeNull();
    expect(
      asProviderModelsFetchRequest({
        url: 'https://a.com',
        headers: { ['x'.repeat(257)]: 'v' },
      }),
    ).toBeNull();
    expect(
      asProviderModelsFetchRequest({
        url: 'https://a.com',
        headers: { a: 'v'.repeat(16385) },
      }),
    ).toBeNull();
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`h${i}`, 'v']),
    );
    expect(asProviderModelsFetchRequest({ url: 'https://a.com', headers: tooMany })).toBeNull();
  });

  it('defaults and clamps timeoutMs', () => {
    expect(asProviderModelsFetchRequest({ url: 'https://a.com' })?.timeoutMs).toBe(30000);
    expect(asProviderModelsFetchRequest({ url: 'https://a.com', timeoutMs: 0 })?.timeoutMs).toBe(1);
    expect(asProviderModelsFetchRequest({ url: 'https://a.com', timeoutMs: 999999 })?.timeoutMs).toBe(30000);
    expect(
      asProviderModelsFetchRequest({ url: 'https://a.com', timeoutMs: Number.NaN })?.timeoutMs,
    ).toBe(30000);
  });

  it('defaults headers to an empty map', () => {
    expect(asProviderModelsFetchRequest({ url: 'https://a.com' })?.headers).toEqual({});
  });
});

describe('fetchProviderModelsViaNet', () => {
  beforeEach(() => {
    netFetchMock.mockReset();
  });

  it('performs a GET with headers and returns status plus body', async () => {
    netFetchMock.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const result = await fetchProviderModelsViaNet({
      url: 'https://api.example.com/v1/models',
      headers: { authorization: 'Bearer sk-test' },
      timeoutMs: 15000,
    });
    expect(result).toEqual({ ok: true, status: 200, body: '{"data":[]}' });
    const [url, init] = netFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ authorization: 'Bearer sk-test' });
  });

  it('truncates the body at the cap', async () => {
    netFetchMock.mockResolvedValue(new Response('x'.repeat(1_048_577), { status: 200 }));
    const result = await fetchProviderModelsViaNet({
      url: 'https://api.example.com/v1/models',
      headers: {},
      timeoutMs: 15000,
    });
    expect(result).toEqual({ ok: true, status: 200, body: 'x'.repeat(1_048_576) });
  });

  it('returns a network failure when the request throws', async () => {
    netFetchMock.mockRejectedValue(new Error('connection refused'));
    const result = await fetchProviderModelsViaNet({
      url: 'https://api.example.com/v1/models',
      headers: {},
      timeoutMs: 15000,
    });
    expect(result).toEqual({ ok: false, kind: 'network' });
  });

  it('returns a timeout failure when the abort signal times out', async () => {
    netFetchMock.mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'));
    const result = await fetchProviderModelsViaNet({
      url: 'https://api.example.com/v1/models',
      headers: {},
      timeoutMs: 15000,
    });
    expect(result).toEqual({ ok: false, kind: 'timeout' });
  });
});
