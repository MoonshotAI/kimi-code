import { describe, expect, it } from 'vitest';

import { mergeCallerMcpServers, type SessionMcpConfig } from '#/agent/mcp/session-config';
import type { McpServerConfig } from '#/agent/mcp/config-schema';

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

  it('handles caller servers with null/undefined config values', () => {
    const base: SessionMcpConfig = { servers: { fs: stdio('fs') } };
    const callerServers = { fs: null as unknown as McpServerConfig, extra: undefined as unknown as McpServerConfig };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(result?.servers['fs']).toBeDefined();
    expect(result?.servers['extra']).toBeDefined();
  });

  it('preserves caller servers with duplicate names when caller wins', () => {
    const base: SessionMcpConfig = { servers: { dup: stdio('base-dup') } };
    const callerServers = { dup: http('https://caller-dup.example.com') };
    const result = mergeCallerMcpServers(base, callerServers);
    expect(result?.servers['dup']).toEqual(http('https://caller-dup.example.com'));
    expect(Object.keys(result?.servers ?? {})).toHaveLength(1);
  });
});
