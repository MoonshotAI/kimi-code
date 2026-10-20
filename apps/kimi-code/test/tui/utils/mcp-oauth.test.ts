import {
  MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
  type ToolUpdate,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  McpOAuthAuthorizationUrlOpener,
  type OpenUrl,
  parseMcpOAuthAuthorizationUrlUpdate,
} from '#/tui/utils/mcp-oauth';

describe('parseMcpOAuthAuthorizationUrlUpdate', () => {
  it('extracts MCP OAuth authorization URLs from structured tool updates', () => {
    const update: ToolUpdate = {
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
      customData: {
        serverName: 'linear',
        authorizationUrl: 'https://linear.example/oauth?state=abc',
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(update)).toEqual({
      serverName: 'linear',
      authorizationUrl: 'https://linear.example/oauth?state=abc',
    });
  });

  it('ignores unrelated or malformed updates', () => {
    const unrelated: ToolUpdate = {
      kind: 'status',
      text: 'https://linear.example/oauth?state=abc',
    };
    const malformed: ToolUpdate = {
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
      customData: {
        serverName: 'linear',
        authorizationUrl: 'file:///tmp/callback',
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(unrelated)).toBeUndefined();
    expect(parseMcpOAuthAuthorizationUrlUpdate(malformed)).toBeUndefined();
  });
});

describe('McpOAuthAuthorizationUrlOpener', () => {
  it('opens authorization URLs from structured tool progress updates', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);

    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: authorizationUrlUpdate('https://linear.example/oauth?state=abc'),
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://linear.example/oauth?state=abc');
  });

  it('opens each authorization URL once per tool call', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const update = authorizationUrlUpdate('https://linear.example/oauth?state=abc');

    opener.handleToolProgress({ toolCallId: 'tool-1', update });
    opener.handleToolProgress({ toolCallId: 'tool-1', update });
    opener.handleToolProgress({ toolCallId: 'tool-2', update });

    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenNthCalledWith(1, 'https://linear.example/oauth?state=abc');
    expect(openUrl).toHaveBeenNthCalledWith(2, 'https://linear.example/oauth?state=abc');
  });

  it('ignores progress updates that do not contain an MCP OAuth authorization URL', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);

    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: {
        kind: 'status',
        text: 'https://linear.example/oauth?state=abc',
      },
    });
    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: authorizationUrlUpdate('file:///tmp/callback'),
    });

    expect(openUrl).not.toHaveBeenCalled();
  });
});

function authorizationUrlUpdate(authorizationUrl: string): ToolUpdate {
  return {
    kind: 'custom',
    customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
    customData: {
      serverName: 'linear',
      authorizationUrl,
    },
  };
}
