import { afterEach, describe, expect, it, vi } from 'vitest';
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

const wirePlugin = {
  id: 'kimi-cu',
  display_name: 'Kimi Computer Use',
  version: '0.4.18',
  enabled: true,
  state: 'ok',
  skill_count: 1,
  mcp_server_count: 1,
  enabled_mcp_server_count: 1,
  hook_count: 0,
  command_count: 0,
  has_errors: false,
  source: 'zip-url',
  origin: 'marketplace',
  installed_at: '2026-01-01T00:00:00.000Z',
};

const wireEntry = {
  id: 'kimi-cu',
  tier: 'official',
  display_name: 'Kimi Computer Use',
  source: 'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
  installed: { version: '0.4.18', enabled: true },
};

describe('DaemonKimiWebApi plugins', () => {
  it('listPlugins GETs /plugins and maps snake_case fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ plugins: [wirePlugin] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listPlugins();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins');
    expect(init.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      skillCount: 1,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      enabled: true,
    });
  });

  it('listPluginMarketplace GETs /plugins/marketplace and maps snake_case fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ entries: [wireEntry] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listPluginMarketplace();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/plugins/marketplace');
    expect(result[0]).toMatchObject({
      id: 'kimi-cu',
      tier: 'official',
      displayName: 'Kimi Computer Use',
    });
  });

  it('maps a non-envelope JSON error to the HTTP status as code', async () => {
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

  it('installPlugin POSTs snake_case marketplace identity, expected version and digest with an archive timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wirePlugin));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await makeApi().installPlugin({
      marketplaceId: 'demo',
      expectedVersion: '1.2.3',
      expectedSha256: 'a'.repeat(64),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      marketplace_id: 'demo',
      expected_version: '1.2.3',
      expected_sha256: 'a'.repeat(64),
    });
    expect(timeout).toHaveBeenCalledWith(180_000);
    timeout.mockRestore();
  });

  it('getPluginInfo GETs the installed plugin details', async () => {
    const wireCapabilities = {
      skills: [{ name: 'kimi-cu', description: 'GUI automation' }],
      mcp_servers: [
        { name: 'kimi-cu', runtime_name: 'plugin-kimi-cu:kimi-cu', enabled: true, transport: 'stdio' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireCapabilities));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getPluginInfo('kimi-cu');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins/kimi-cu');
    expect(init.method).toBe('GET');
    expect(result).toEqual({
      skills: [{ name: 'kimi-cu', displayName: undefined, description: 'GUI automation' }],
      mcpServers: [
        {
          name: 'kimi-cu',
          displayName: undefined,
          description: undefined,
          iconUrl: undefined,
          runtimeName: 'plugin-kimi-cu:kimi-cu',
          enabled: true,
          transport: 'stdio',
          command: undefined,
          args: undefined,
          cwd: undefined,
          url: undefined,
          envKeys: undefined,
          headerKeys: undefined,
        },
      ],
    });
  });

  it('previewPlugin POSTs snake_case marketplace identity, expected version and digest', async () => {
    const wireCapabilities = { skills: [{ name: 'demo' }], mcp_servers: [] };
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireCapabilities));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    const result = await makeApi().previewPlugin({
      marketplaceId: 'demo',
      expectedVersion: '1.2.3',
      expectedSha256: 'a'.repeat(64),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/plugins/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      marketplace_id: 'demo',
      expected_version: '1.2.3',
      expected_sha256: 'a'.repeat(64),
    });
    expect(result).toEqual({
      skills: [{ name: 'demo', displayName: undefined, description: undefined }],
      mcpServers: [],
    });
    expect(timeout).toHaveBeenCalledWith(180_000);
  });

  it('setPluginEnabled POSTs :enable / :disable', async () => {
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

describe('DaemonKimiWebApi MCP OAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gets auth statuses without active verification', async () => {
    const wireStatuses = [{ name: 'plugin-vercel:vercel', auth_status: 'oauth-required' }];
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireStatuses));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getMcpAuthStatuses();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/auth-statuses?verify=false');
    expect(init.method).toBe('GET');
    expect(result).toEqual([{ name: 'plugin-vercel:vercel', authStatus: 'oauth-required' }]);
  });

  it('inspects only targeted servers with active verification', async () => {
    const wireInspections = [
      { runtime_name: 'plugin-vercel:vercel', auth_status: 'oauth-required' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireInspections));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().inspectMcpAuthStatuses([
      { source: 'plugin', pluginId: 'vercel', serverName: 'vercel' },
    ], { cwd: '/workspace/demo' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/servers::inspect');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      targets: [{ source: 'plugin', plugin_id: 'vercel', server_name: 'vercel' }],
      cwd: '/workspace/demo',
    });
    expect(result).toEqual([
      { name: 'plugin-vercel:vercel', authStatus: 'oauth-required' },
    ]);
  });

  it('begins a plugin authorization with the workspace in the query', async () => {
    const wireBeginResult = {
      status: 'authorization-required',
      flow_id: 'flow-1',
      authorization_url: 'https://auth.example.test/authorize',
    };
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireBeginResult));
    vi.stubGlobal('fetch', fetchMock);
    const locator = { source: 'plugin', pluginId: 'vercel', serverName: 'vercel' } as const;

    const result = await makeApi().beginMcpAuth(locator, { cwd: '/workspace/demo' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/auth:begin?cwd=%2Fworkspace%2Fdemo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      source: 'plugin',
      plugin_id: 'vercel',
      server_name: 'vercel',
    });
    expect(result).toEqual({
      status: 'authorization-required',
      flowId: 'flow-1',
      authorizationUrl: 'https://auth.example.test/authorize',
    });
  });

  it('completes authorization with the caller signal and matching wait timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(null));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();

    const result = await makeApi().completeMcpAuth({
      flowId: 'flow-1',
      timeoutMs: 900_000,
      signal: controller.signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/auth:complete');
    expect(JSON.parse(init.body as string)).toEqual({ flow_id: 'flow-1', timeout_ms: 900_000 });
    expect(timeout).toHaveBeenCalledWith(900_000);
    expect(result).toBeNull();
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('cancels authorization by flow id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(null));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().cancelMcpAuth('flow-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/auth:cancel');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ flow_id: 'flow-1' });
    expect(result).toBeNull();
  });

  it('resets stored authorization for a plugin MCP server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(null));
    vi.stubGlobal('fetch', fetchMock);
    const locator = { source: 'plugin', pluginId: 'vercel', serverName: 'vercel' } as const;

    const result = await makeApi().resetMcpAuth(locator, { cwd: '/workspace/demo' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/mcp/auth:reset?cwd=%2Fworkspace%2Fdemo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      source: 'plugin',
      plugin_id: 'vercel',
      server_name: 'vercel',
    });
    expect(result).toBeNull();
  });
});
