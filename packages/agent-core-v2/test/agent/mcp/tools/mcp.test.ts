import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { createMcpTool } from '#/agent/mcp/tools/mcp';
import type { MCPClient } from '#/mcpCore/types';

import { executeTool, fakeMcpClient } from '../../../mcpCore/stubs';

const echoTool = {
  name: 'echo',
  description: 'Echoes back',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function unauthorizedError(): Error {
  return Object.assign(new Error('HTTP 401: Unauthorized'), { code: 401 });
}

function failingClient(error: unknown): MCPClient {
  const base = fakeMcpClient();
  return {
    ...base,
    callTool: () => Promise.reject(error),
  };
}

describe('createMcpTool', () => {
  it('passes a successful call through to the executable output', async () => {
    const tool = createMcpTool('mcp__hyper__echo', echoTool, fakeMcpClient(), {
      serverName: 'hyper',
    });
    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'tc',
      args: { text: 'hi' },
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.output)).toContain('hi');
  });

  it('reports 401 to onUnauthorized and throws guidance towards the authenticate tool', async () => {
    const error = unauthorizedError();
    const client = failingClient(error);
    const reconnect = vi.fn();
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const tool = createMcpTool('mcp__hyper__echo', echoTool, client, {
      serverName: 'hyper',
      reconnect,
      onUnauthorized,
    });
    await expect(
      executeTool(tool, {
        turnId: 0,
        toolCallId: 'tc',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/mcp__hyper__authenticate/);
    expect(onUnauthorized).toHaveBeenCalledWith(error, client);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('propagates the original error when onUnauthorized declines it', async () => {
    const error = unauthorizedError();
    const client = failingClient(error);
    const onUnauthorized = vi.fn().mockResolvedValue(false);
    const tool = createMcpTool('mcp__hyper__echo', echoTool, client, {
      serverName: 'hyper',
      onUnauthorized,
    });
    await expect(
      executeTool(tool, {
        turnId: 0,
        toolCallId: 'tc',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('HTTP 401: Unauthorized');
    expect(onUnauthorized).toHaveBeenCalledWith(error, client);
  });

  it('routes a 401 from the liveness-probe retry through onUnauthorized', async () => {
    const transportError = new Error('socket hang up');
    const error = unauthorizedError();
    let calls = 0;
    const client: MCPClient = {
      ...fakeMcpClient(),
      callTool: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(transportError) : Promise.reject(error);
      },
    };
    const reconnect = vi.fn();
    const onUnauthorized = vi.fn(async (e: unknown) => e === error);
    const tool = createMcpTool('mcp__hyper__echo', echoTool, client, {
      serverName: 'hyper',
      reconnect,
      onUnauthorized,
    });
    await expect(
      executeTool(tool, {
        turnId: 0,
        toolCallId: 'tc',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/mcp__hyper__authenticate/);
    expect(onUnauthorized).toHaveBeenCalledWith(transportError, client);
    expect(onUnauthorized).toHaveBeenCalledWith(error, client);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('routes a 401 from the post-reconnect call through onUnauthorized', async () => {
    const closedError = Object.assign(new Error('connection closed'), {
      code: ErrorCode.ConnectionClosed,
    });
    const error = unauthorizedError();
    const staleClient: MCPClient = {
      ...fakeMcpClient(),
      callTool: () => Promise.reject(closedError),
    };
    const freshClient: MCPClient = {
      ...fakeMcpClient(),
      callTool: () => Promise.reject(error),
    };
    const onUnauthorized = vi.fn(async (e: unknown) => e === error);
    const tool = createMcpTool('mcp__hyper__echo', echoTool, staleClient, {
      serverName: 'hyper',
      reconnect: async () => freshClient,
      onUnauthorized,
    });
    await expect(
      executeTool(tool, {
        turnId: 0,
        toolCallId: 'tc',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/mcp__hyper__authenticate/);
    expect(onUnauthorized).toHaveBeenCalledWith(error, freshClient);
  });
});
