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
        envelope({
          providers: {},
          secondary_model: {
            defaultModel: 'kimi/k2',
            defaultEffort: 'high',
            models: { 'kimi/k2': '' },
          },
        }),
      ),
    );

    const config = await makeApi().getConfig();

    expect(config.secondaryModel).toEqual({
      defaultModel: 'kimi/k2',
      defaultEffort: 'high',
      models: { 'kimi/k2': '' },
    });
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
      envelope({ providers: {}, secondary_model: { defaultModel: 'kimi/k2', defaultEffort: 'high' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = await makeApi().setConfig({
      secondaryModel: { defaultModel: 'kimi/k2', defaultEffort: 'high' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/config');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      secondary_model: { defaultModel: 'kimi/k2', defaultEffort: 'high' },
    });
    expect(config.secondaryModel).toEqual({ defaultModel: 'kimi/k2', defaultEffort: 'high' });
  });

  it('POSTs null to clear the secondary model configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ providers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const config = await makeApi().setConfig({ secondaryModel: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ secondary_model: null });
    expect(config.secondaryModel).toBeUndefined();
  });
});

describe('DaemonKimiWebApi config disableFeedbackSurvey', () => {
  it('maps the wire disable_feedback_survey key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelope({ providers: {}, disable_feedback_survey: true })),
    );

    const config = await makeApi().getConfig();

    expect(config.disableFeedbackSurvey).toBe(true);
  });

  it('POSTs disable_feedback_survey and maps the echoed config', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope({ providers: {}, disable_feedback_survey: false }));
    vi.stubGlobal('fetch', fetchMock);

    const config = await makeApi().setConfig({ disableFeedbackSurvey: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ disable_feedback_survey: false });
    expect(config.disableFeedbackSurvey).toBe(false);
  });
});

describe('DaemonKimiWebApi.getMeta experimental_flags', () => {
  const wireMeta = {
    server_version: '1.0.0',
    server_id: 'srv_t',
    started_at: '2026-01-01T00:00:00Z',
    home_dir: '/home/me/.kimi-code',
    capabilities: { websocket: true },
    backend: 'v2',
  };

  it('maps home_dir to the server data directory', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(wireMeta)));

    const meta = await makeApi().getMeta();

    expect(meta.homeDir).toBe('/home/me/.kimi-code');
  });

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

  it('maps web_title when the server reports it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(envelope({ ...wireMeta, web_title: 'My Dev Box' })),
    );

    const meta = await makeApi().getMeta();

    expect(meta.webTitle).toBe('My Dev Box');
  });

  it("defaults webTitle to '' when the server omits the field", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(wireMeta)));

    const meta = await makeApi().getMeta();

    expect(meta.webTitle).toBe('');
  });

  it('maps the device id of the machine the server runs on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ ...wireMeta, device_id: 'rc-this-mac', device_api_level: 1 })));

    const meta = await makeApi().getMeta();

    expect(meta.deviceId).toBe('rc-this-mac');
  });
});
