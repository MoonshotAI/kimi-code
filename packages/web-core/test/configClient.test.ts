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

describe('DaemonKimiWebApi.getConfig secondary_model', () => {
  it('maps the wire secondary_model passthrough (camelCase inner keys)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelope({ providers: {}, secondary_model: { model: 'kimi/k2', defaultEffort: 'high' } }),
      ),
    );

    const config = await makeApi().getConfig();

    expect(config.secondaryModel).toEqual({ model: 'kimi/k2', defaultEffort: 'high' });
  });

  it('leaves secondaryModel undefined when the server omits the field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ providers: {} })));

    const config = await makeApi().getConfig();

    expect(config.secondaryModel).toBeUndefined();
  });
});

describe('DaemonKimiWebApi.setConfig secondaryModel', () => {
  it('POSTs the secondary_model wire key and maps the echoed config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ providers: {}, secondary_model: { model: 'kimi/k2', defaultEffort: 'high' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = await makeApi().setConfig({
      secondaryModel: { model: 'kimi/k2', defaultEffort: 'high' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/config');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      secondary_model: { model: 'kimi/k2', defaultEffort: 'high' },
    });
    expect(config.secondaryModel).toEqual({ model: 'kimi/k2', defaultEffort: 'high' });
  });
});

describe('DaemonKimiWebApi.getMeta experimental_flags', () => {
  const wireMeta = {
    server_version: '1.0.0',
    server_id: 'srv_t',
    started_at: '2026-01-01T00:00:00Z',
    capabilities: { websocket: true },
    backend: 'v2',
  };

  it('maps experimental_flags when the server reports it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelope({ ...wireMeta, experimental_flags: { 'secondary-model': true } }),
      ),
    );

    const meta = await makeApi().getMeta();

    expect(meta.experimentalFlags).toEqual({ 'secondary-model': true });
  });

  it('defaults experimentalFlags to {} when the server omits the field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(wireMeta)));

    const meta = await makeApi().getMeta();

    expect(meta.experimentalFlags).toEqual({});
  });
});
