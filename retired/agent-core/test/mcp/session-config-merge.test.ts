import { describe, expect, it } from 'vitest';

import { mergeCallerMcpServers, type SessionMcpConfig } from '../../src/mcp/session-config';
import type { McpServerConfig } from '../../src/config/schema';

const stdio = (command: string): McpServerConfig => ({
  transport: 'stdio',
  command,
});

const http = (url: string): McpServerConfig => ({
  transport: 'http',
  url,
});

describe('mergeCallerMcpServers', () => {
  it('returns base unchanged when callerServers is undefined', () => {
    const base: SessionMcpConfig = { servers: { fs: stdio('fs') } };
    expect(mergeCallerMcpServers(base, undefined)).toBe(base);
  });

  it('returns base unchanged when callerServers is empty', () => {
    const base: SessionMcpConfig = { servers: { fs: stdio('fs') } };
    expect(mergeCallerMcpServers(base, {})).toBe(base);
  });

  it('returns undefined when both base and callerServers are absent', () => {
    expect(mergeCallerMcpServers(undefined, undefined)).toBeUndefined();
    expect(mergeCallerMcpServers(undefined, {})).toBeUndefined();
  });

  it('promotes a caller-only payload into a fresh SessionMcpConfig when base is undefined', () => {
    const callerServers = { docs: http('https://mcp.example.com') };
    expect(mergeCallerMcpServers(undefined, callerServers)).toEqual({
      servers: { docs: http('https://mcp.example.com') },
    });
  });

  it('layers caller on top of base with caller winning on key collision', () => {
    const base: SessionMcpConfig = {
      servers: {
        shared: stdio('disk-version'),
        diskOnly: stdio('disk-only'),
      },
    };
    const callerServers = {
      shared: stdio('caller-version'),
      callerOnly: http('https://caller.example.com'),
    };
    expect(mergeCallerMcpServers(base, callerServers)).toEqual({
      servers: {
        shared: stdio('caller-version'),
        diskOnly: stdio('disk-only'),
        callerOnly: http('https://caller.example.com'),
      },
    });
  });

  it('handles base with empty servers object', () => {
    const base: SessionMcpConfig = { servers: {} };
    const callerServers = { fs: stdio('fs') };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(result?.servers['fs']).toEqual({ transport: 'stdio', command: 'fs' });
  });

  it('caller overrides same key with different transport type', () => {
    const base: SessionMcpConfig = {
      servers: { api: stdio('local-api') },
    };
    const callerServers = { api: http('https://remote.example.com/api') };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(result?.servers['api']).toEqual({ transport: 'http', url: 'https://remote.example.com/api' });
  });

  it('layers many caller servers on top of an empty base', () => {
    const base: SessionMcpConfig = { servers: {} };
    const callerServers: Record<string, McpServerConfig> = {
      fs: stdio('fs'),
      docs: http('https://docs.example.com/mcp'),
      search: { transport: 'stdio', command: 'search', args: ['--index', '/tmp'] },
    };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(Object.keys(result!.servers).length).toBe(3);
    expect(result!.servers['search']).toEqual({
      transport: 'stdio',
      command: 'search',
      args: ['--index', '/tmp'],
    });
  });

  it('returns a new object when caller overrides base (no mutation)', () => {
    const base: SessionMcpConfig = { servers: { shared: stdio('original') } };
    const callerServers = { shared: stdio('override') };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(result).not.toBe(base);
    expect(base.servers['shared']).toEqual({ transport: 'stdio', command: 'original' });
  });
});
