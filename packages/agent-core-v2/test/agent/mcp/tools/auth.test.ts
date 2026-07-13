import { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { AlreadyAuthorizedError, type BeginAuthorizationResult, type McpOAuthService } from '#/agent/mcp/oauth/service';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import type { ToolUpdate } from '#/tool/toolContract';

import { executeTool } from '../stubs';

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
  const signal = opts.signal ?? new AbortController().signal;
  const updates: ToolUpdate[] = [];
  const result = executeTool(tool, {
    turnId: 0,
    toolCallId: 'tc',
    args: {},
    signal,
    onUpdate: (u) => updates.push(u),
  });
  return { result, updates, tool };
}

describe('createMcpAuthTool', () => {
  it('returns the authorization URL via status updates and final output on success', async () => {
    let reconnectCalls = 0;
    const oauthService = fakeOAuthService(async () => ({
      authorizationUrl: new URL('https://example.com/authorize?state=abc'),
      complete: async () => undefined,
      cancel: async () => undefined,
    }));
    const { result, updates } = runTool({
      oauthService,
      reconnect: async () => {
        reconnectCalls += 1;
      },
    });
    const final = await result;
    expect(final.isError).toBeUndefined();
    expect(final.output).toMatch(/authenticated successfully/);
    expect(reconnectCalls).toBe(1);
    expect(updates.some((u) => u.text?.includes('https://example.com/authorize'))).toBe(true);
    expect(updates).toContainEqual({
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
      customData: {
        serverName: 'notion',
        authorizationUrl: 'https://example.com/authorize?state=abc',
      },
    });
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
