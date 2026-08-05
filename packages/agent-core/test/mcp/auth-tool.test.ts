import { describe, expect, it } from 'vitest';

import type { ToolUpdate } from '../../src/loop';
import { createMcpAuthTool } from '../../src/mcp/auth-tool';
import {
  AlreadyAuthorizedError,
  type BeginAuthorizationResult,
  type McpOAuthService,
} from '../../src/mcp/oauth';
import { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '../../src/rpc/events';
import { executeTool } from '../tools/fixtures/execute-tool';

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
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  const updates: ToolUpdate[] = [];
  const result = executeTool(tool, {
    turnId: 't',
    toolCallId: 'tc',
    args: {},
    signal,
    onUpdate: (u) => updates.push(u),
  });
  return { result, controller, updates, tool };
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
    const authUpdate = updates.find(
      (u) => u.kind === 'custom' && u.customKind === MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
    );
    expect(authUpdate?.customData).toMatchObject({
      serverName: 'notion',
      authorizationUrl: 'https://example.com/authorize?state=abc',
    });
    // The deadline is absolute (now + wait timeout), so hosts never mirror
    // the engine-side constant.
    const { expiresAt } = authUpdate?.customData as { expiresAt?: number };
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

  it('returns isError and surfaces the URL when complete() rejects', async () => {
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
