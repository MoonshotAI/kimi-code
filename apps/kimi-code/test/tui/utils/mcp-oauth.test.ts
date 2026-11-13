import { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  McpOAuthAuthorizationUrlOpener,
  type OpenUrl,
  parseMcpOAuthAuthorizationUrlUpdate,
} from '#/tui/utils/mcp-oauth';

describe('parseMcpOAuthAuthorizationUrlUpdate', () => {
  it('extracts MCP OAuth authorization URLs from structured tool updates', () => {
    const fields = authorizationUrlFields('https://linear.example/oauth?state=abc');

    expect(parseMcpOAuthAuthorizationUrlUpdate(fields)).toEqual({
      serverName: 'linear',
      authorizationUrl: 'https://linear.example/oauth?state=abc',
    });
  });

  it('ignores unrelated or malformed updates', () => {
    const unrelated = { status: 'https://linear.example/oauth?state=abc' };
    const malformed = {
      [MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE]: {
        serverName: 'linear',
        authorizationUrl: 'file:///tmp/callback',
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(unrelated)).toBeUndefined();
    expect(parseMcpOAuthAuthorizationUrlUpdate(malformed)).toBeUndefined();
  });
});

describe('McpOAuthAuthorizationUrlOpener', () => {
  it('opens authorization URLs from structured tool fields', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);

    opener.handleToolUpdated({
      toolCallId: 'tool-1',
      fields: authorizationUrlFields('https://linear.example/oauth?state=abc'),
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://linear.example/oauth?state=abc');
  });

  it('opens each authorization URL once per tool call', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const fields = authorizationUrlFields('https://linear.example/oauth?state=abc');

    opener.handleToolUpdated({ toolCallId: 'tool-1', fields });
    opener.handleToolUpdated({ toolCallId: 'tool-1', fields });
    opener.handleToolUpdated({ toolCallId: 'tool-2', fields });

    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenNthCalledWith(1, 'https://linear.example/oauth?state=abc');
    expect(openUrl).toHaveBeenNthCalledWith(2, 'https://linear.example/oauth?state=abc');
  });

  it('ignores field updates that do not contain an MCP OAuth authorization URL', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);

    opener.handleToolUpdated({
      toolCallId: 'tool-1',
      fields: { status: 'https://linear.example/oauth?state=abc' },
    });
    opener.handleToolUpdated({
      toolCallId: 'tool-1',
      fields: authorizationUrlFields('file:///tmp/callback'),
    });

    expect(openUrl).not.toHaveBeenCalled();
  });
});

function authorizationUrlFields(authorizationUrl: string): Readonly<Record<string, unknown>> {
  return {
    [MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE]: {
      serverName: 'linear',
      authorizationUrl,
    },
  };
}
