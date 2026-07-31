import { describe, expect, it } from 'vitest';

import {
  mergeCallerMcpServers,
  filterMcpServersByModel,
  mcpServerAppliesToModel,
  type SessionMcpConfig,
} from '../../src/mcp/session-config';
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
});

describe('filterMcpServersByModel', () => {
  const unscoped: McpServerConfig = { transport: 'stdio', command: 'fs' };
  const visionOnly: McpServerConfig = {
    transport: 'stdio',
    command: 'vision',
    models: ['example-provider/vision-large'],
  };
  const providerPrefix: McpServerConfig = {
    transport: 'stdio',
    command: 'vision',
    models: ['example-provider/*'],
  };

  it('keeps unscoped servers for any model (backward compatible)', () => {
    const cfg: SessionMcpConfig = { servers: { fs: unscoped } };
    expect(filterMcpServersByModel(cfg, 'other-provider/chat-model')).toEqual(cfg);
    expect(filterMcpServersByModel(cfg, undefined)).toEqual(cfg);
  });

  it('keeps a model-scoped server only when the alias matches exactly', () => {
    const cfg: SessionMcpConfig = { servers: { vision: visionOnly } };
    expect(filterMcpServersByModel(cfg, 'example-provider/vision-large')?.servers).toHaveProperty(
      'vision',
    );
    // A different model must NOT get the vision-only MCP.
    expect(
      filterMcpServersByModel(cfg, 'other-provider/chat-model'),
    ).toBeUndefined();
  });

  it('honors a trailing-* prefix wildcard', () => {
    const cfg: SessionMcpConfig = { servers: { vision: providerPrefix } };
    expect(filterMcpServersByModel(cfg, 'example-provider/vision-large')?.servers).toHaveProperty(
      'vision',
    );
    expect(filterMcpServersByModel(cfg, 'example-provider/text-small')?.servers).toHaveProperty(
      'vision',
    );
    expect(
      filterMcpServersByModel(cfg, 'other-provider/chat-model'),
    ).toBeUndefined();
  });

  it('excludes model-scoped servers when the model is unknown', () => {
    const cfg: SessionMcpConfig = { servers: { vision: visionOnly } };
    // Undecided model → do not leak a scoped MCP into the session.
    expect(filterMcpServersByModel(cfg, undefined)).toBeUndefined();
  });

  it('filters a mixed set down to the matching subset', () => {
    const cfg: SessionMcpConfig = { servers: { fs: unscoped, vision: visionOnly } };
    // A matching session keeps both; a non-matching session keeps only the unscoped one.
    expect(filterMcpServersByModel(cfg, 'example-provider/vision-large')?.servers).toEqual({
      fs: unscoped,
      vision: visionOnly,
    });
    expect(filterMcpServersByModel(cfg, 'other-provider/chat-model')?.servers).toEqual({
      fs: unscoped,
    });
  });

  it('mcpServerAppliesToModel: unscoped server always applies', () => {
    expect(mcpServerAppliesToModel(unscoped, undefined)).toBe(true);
  });
});
