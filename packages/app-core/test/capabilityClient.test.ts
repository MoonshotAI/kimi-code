import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonApiError } from '../src/api/errors';

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

const wireCapability = {
  id: 'kimi-cu',
  displayName: 'Kimi Computer Use',
  description: 'macOS GUI automation',
  supported: true,
  state: 'partial',
  version: '0.4.18',
  steps: [
    { id: 'plugin', state: 'ok', detail: '0.4.18' },
    { id: 'permissions', state: 'missing', detail: 'screenRecording' },
  ],
  install: { running: false },
};

describe('DaemonKimiWebApi capabilities', () => {
  it('listCapabilities GETs /capabilities and returns the array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope({ capabilities: [wireCapability] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listCapabilities();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/capabilities');
    expect(init.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'kimi-cu', state: 'partial', version: '0.4.18' });
  });

  it('listCapabilities tolerates a missing capabilities field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({})));
    expect(await makeApi().listCapabilities()).toEqual([]);
  });

  it('getCapability GETs the encoded id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireCapability));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getCapability('kimi-cu');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/capabilities/kimi-cu');
    expect(result.steps).toHaveLength(2);
  });

  it('installCapability POSTs the :install action', async () => {
    const installing = { ...wireCapability, install: { running: true, step: 'plugin' } };
    const fetchMock = vi.fn().mockResolvedValue(envelope(installing));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().installCapability('kimi-cu');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/capabilities/kimi-cu:install');
    expect(init.method).toBe('POST');
    expect(result.install).toEqual({ running: true, step: 'plugin' });
  });

  it('surfaces wire error codes via DaemonApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 40923,
            msg: 'Capability "kimi-cu" is not supported on linux/x64',
            data: null,
            request_id: 'req_t',
          }),
          { status: 200 },
        ),
      ),
    );

    const error = await makeApi()
      .installCapability('kimi-cu')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonApiError);
    expect((error as DaemonApiError).code).toBe(40923);
  });
});
