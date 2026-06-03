import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUndiciFetch = vi.hoisted(() => vi.fn());
const MockEnvHttpProxyAgent = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
  fetch: mockUndiciFetch,
  EnvHttpProxyAgent: MockEnvHttpProxyAgent,
}));

describe('getProxyFetch', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    mockUndiciFetch.mockClear();
    MockEnvHttpProxyAgent.mockClear();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it('returns global fetch when no proxy variables are set', async () => {
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const result = getProxyFetch();
    expect(result).toBe(originalFetch);
  });

  it('creates an agent and returns a wrapped fetch when HTTP_PROXY is set', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const result = getProxyFetch();

    expect(result).not.toBe(originalFetch);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(1);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      noProxy: 'localhost,127.0.0.1',
    });

    const requestInit = { method: 'POST' };
    await result('https://api.example.com', requestInit);
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    expect(mockUndiciFetch).toHaveBeenCalledWith(
      'https://api.example.com',
      expect.objectContaining({ method: 'POST', dispatcher: expect.anything() }),
    );
  });

  it('honours lowercase http_proxy', async () => {
    process.env['http_proxy'] = 'http://proxy.example.com:8080';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const result = getProxyFetch();

    expect(result).not.toBe(originalFetch);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it('honours HTTPS_PROXY', async () => {
    process.env['HTTPS_PROXY'] = 'https://proxy.example.com:8443';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const result = getProxyFetch();

    expect(result).not.toBe(originalFetch);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it('passes NO_PROXY to the agent', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    process.env['NO_PROXY'] = 'example.com,internal.local';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    getProxyFetch();

    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      noProxy: 'example.com,internal.local',
    });
  });

  it('passes lowercase no_proxy to the agent', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    process.env['no_proxy'] = 'example.com';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    getProxyFetch();

    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      noProxy: 'example.com',
    });
  });

  it('prefers lowercase no_proxy over uppercase NO_PROXY when both are set', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    process.env['NO_PROXY'] = 'uppercase.example.com';
    process.env['no_proxy'] = 'lowercase.example.com';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    getProxyFetch();

    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      noProxy: 'lowercase.example.com',
    });
  });

  it('caches the fetch implementation across calls', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const first = getProxyFetch();
    const second = getProxyFetch();

    expect(second).toBe(first);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(1);
  });

  it('delegates to global fetch when it has been replaced (e.g. mocked)', async () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    vi.resetModules();
    const { getProxyFetch } = await import('#/proxy');
    const proxyFetch = getProxyFetch();

    const mockGlobalFetch = vi.fn();
    globalThis.fetch = mockGlobalFetch;

    await proxyFetch('https://api.example.com', { method: 'GET' });
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
    expect(mockGlobalFetch).toHaveBeenCalledWith('https://api.example.com', { method: 'GET' });
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });
});
