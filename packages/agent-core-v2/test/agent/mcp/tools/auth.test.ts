import { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '#/agent/mcp/tools/auth';
import { describe, expect, it } from 'vitest';

import { AlreadyAuthorizedError, type BeginAuthorizationResult, type McpOAuthService } from '#/mcpCore/oauth/service';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { LegacyExecutableToolAdapter, ToolExecutor } from '#/tool/executor';

function fakeOAuthService(
  begin: (
    serverName: string,
    serverUrl: string | URL,
  ) => Promise<BeginAuthorizationResult> | BeginAuthorizationResult,
): McpOAuthService {
  return {
    beginAuthorization: async (serverName: string, serverUrl: string | URL) =>
      begin(serverName, serverUrl),
  } as unknown as McpOAuthService;
}

function runTool(opts: {
  oauthService: McpOAuthService;
  reconnect: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}) {
  const tool = createMcpAuthTool({
    serverName: 'notion',
    serverUrl: 'https://example.com/mcp',
    oauthService: opts.oauthService,
    reconnect: opts.reconnect,
    timeoutMs: 100,
  });
  const handler = new ToolExecutor([new LegacyExecutableToolAdapter(tool)]).execute(
    { type: 'function', id: 'tc', name: tool.name, arguments: '{}' },
    { turnId: 0 },
  );
  const snapshots: Array<Readonly<Record<string, unknown>>> = [];
  handler.observe((event) => {
    if (event.type === 'change') snapshots.push(event.snapshot.fields);
  });
  const result = handler.wait().then(() => {
    const prepared = handler.snapshot().prepared;
    if (prepared?.kind === 'execute' && prepared.result !== undefined) return prepared.result;
    if (prepared?.kind === 'synthetic') return prepared.result;
    throw new Error('missing legacy result');
  });
  return { result, snapshots, handler, tool };
}

describe('createMcpAuthTool', () => {
  it('returns the authorization URL via status updates and final output on success', async () => {
    let reconnectCalls = 0;
    const oauthService = fakeOAuthService(async () => ({
      waitId: 'auth-wait',
      authorizationUrl: new URL('https://example.com/authorize?state=abc'),
      complete: async () => undefined,
      cancel: async () => undefined,
    }));
    const { result, snapshots, handler } = runTool({
      oauthService,
      reconnect: async () => {
        reconnectCalls += 1;
      },
    });
    const final = await result;
    expect(final.isError).toBeUndefined();
    expect(final.output).toMatch(/authenticated successfully/);
    expect(reconnectCalls).toBe(1);
    expect(snapshots.some((fields) => {
      const status = fields['status'];
      return typeof status === 'string' && status.includes('https://example.com/authorize');
    })).toBe(true);
    const authUpdate = handler.fields()[MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE];
    expect(authUpdate).toMatchObject({
      waitId: 'auth-wait',
      serverName: 'notion',
      authorizationUrl: 'https://example.com/authorize?state=abc',
    });
    const { expiresAt } = authUpdate as { expiresAt?: number };
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });

  it('falls through to reconnect when the provider reports already-authorized', async () => {
    let reconnectCalls = 0;
    const oauthService = fakeOAuthService(async () => {
      throw new AlreadyAuthorizedError('notion');
    });
    const { result } = runTool({
      oauthService,
      reconnect: async () => {
        reconnectCalls += 1;
      },
    });
    const final = await result;
    expect(final.isError).toBeUndefined();
    expect(final.output).toMatch(/already had valid OAuth credentials/);
    expect(reconnectCalls).toBe(1);
  });

  it('returns isError when beginAuthorization fails outright', async () => {
    const oauthService = fakeOAuthService(async () => {
      throw new Error('DCR unsupported');
    });
    const { result } = runTool({
      oauthService,
      reconnect: async () => undefined,
    });
    const final = await result;
    expect(final.isError).toBe(true);
    expect(final.output).toMatch(/DCR unsupported/);
  });

  it('returns isError and surfaces the URL when complete rejects', async () => {
    const oauthService = fakeOAuthService(async () => ({
      waitId: 'auth-wait',
      authorizationUrl: new URL('https://example.com/authorize?state=abc'),
      complete: async () => {
        throw new Error('OAuth callback timed out');
      },
      cancel: async () => undefined,
    }));
    const { result } = runTool({
      oauthService,
      reconnect: async () => undefined,
    });
    const final = await result;
    expect(final.isError).toBe(true);
    expect(final.output).toMatch(/timed out/);
    expect(final.output).toMatch(/https:\/\/example\.com\/authorize/);
  });

  it('returns isError when reconnect after success fails', async () => {
    const oauthService = fakeOAuthService(async () => ({
      waitId: 'auth-wait',
      authorizationUrl: new URL('https://example.com/authorize?state=abc'),
      complete: async () => undefined,
      cancel: async () => undefined,
    }));
    const { result } = runTool({
      oauthService,
      reconnect: async () => {
        throw new Error('reconnect failed');
      },
    });
    const final = await result;
    expect(final.isError).toBe(true);
    expect(final.output).toMatch(/reconnect failed/);
  });
});
