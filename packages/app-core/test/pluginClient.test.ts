import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
    projectorFactory: () => {
      throw new Error('projector not needed for REST-only tests');
    },
  });
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }), { status });
}

const wirePlugin = {
  id: 'kimi-cu',
  displayName: 'Kimi Computer Use',
  version: '0.4.18',
  enabled: true,
  state: 'ok',
  skillCount: 1,
  mcpServerCount: 1,
  enabledMcpServerCount: 1,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'zip-url',
};

const wireEntry = {
  id: 'kimi-cu',
  tier: 'official',
  displayName: 'Kimi Computer Use',
  source: 'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
  installed: { version: '0.4.18', enabled: true },
};

describe('DaemonKimiWebApi plugins', () => {
  it('listPlugins GETs /plugins', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ plugins: [wirePlugin] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listPlugins();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins');
    expect(init.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'kimi-cu', enabled: true });
  });

  it('listPluginMarketplace GETs /plugins/marketplace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ entries: [wireEntry] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listPluginMarketplace();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/plugins/marketplace');
    expect(result[0]).toMatchObject({ id: 'kimi-cu', tier: 'official' });
  });

  it('maps a non-envelope JSON error to the HTTP status as code', async () => {
    // An older server's bare fastify 404 body is valid JSON but no envelope.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 404, message: 'Not Found' }), { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().installPlugin('/x')).rejects.toMatchObject({ code: 404 });
  });

  it('installPlugin POSTs the source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wirePlugin));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().installPlugin('https://cdn.example.test/p.zip');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ source: 'https://cdn.example.test/p.zip' });
    expect(result.id).toBe('kimi-cu');
  });

  it('setPluginEnabled POSTs :enable / :disable', async () => {
    // Fresh Response per call — a reused Response body can only be consumed once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(envelope({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().setPluginEnabled('kimi-cu', false);
    await makeApi().setPluginEnabled('kimi-cu', true);

    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toEqual([
      'http://test.local/api/v1/plugins/kimi-cu:disable',
      'http://test.local/api/v1/plugins/kimi-cu:enable',
    ]);
  });

  it('removePlugin POSTs :remove', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().removePlugin('kimi-cu');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins/kimi-cu:remove');
    expect(init.method).toBe('POST');
  });
});
