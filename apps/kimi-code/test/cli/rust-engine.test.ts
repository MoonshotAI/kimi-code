import type { McpServerConfig } from '@moonshot-ai/agent-core/config/schema';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSessionHooks, loadSessionMcpServers, loadSessionSystemPrompt, mapMcpServerConfig } from '#/cli/rust-engine';

describe('mapMcpServerConfig', () => {
  it('maps a stdio server to the engine wire spec', () => {
    const config = {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
      cwd: '/repo',
      enabled: true,
      enabledTools: ['read'],
      startupTimeoutMs: 5000,
    } as McpServerConfig;
    const out = mapMcpServerConfig('fs', config, {});
    expect(out).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
      cwd: '/repo',
      enabled: true,
      enabledTools: ['read'],
      startupTimeoutMs: 5000,
    });
    // Stdio never carries remote-only fields.
    expect(out.url).toBeUndefined();
    expect(out.bearerToken).toBeUndefined();
  });

  it('resolves a remote server bearer token from its env var', () => {
    const config = {
      transport: 'http',
      url: 'https://mcp.example.com',
      bearerTokenEnvVar: 'GH_TOKEN',
      headers: { 'X-Trace': '1' },
      enabled: true,
    } as McpServerConfig;
    const out = mapMcpServerConfig('gh', config, { GH_TOKEN: 'secret-123' });
    expect(out).toMatchObject({
      name: 'gh',
      transport: 'http',
      url: 'https://mcp.example.com',
      bearerTokenEnvVar: 'GH_TOKEN',
      bearerToken: 'secret-123',
      hasHeaders: true,
    });
    expect(out.command).toBeUndefined();
  });

  it('leaves the bearer token undefined when the env var is unset', () => {
    const config = {
      transport: 'sse',
      url: 'https://sse.example.com',
      bearerTokenEnvVar: 'MISSING_TOKEN',
    } as McpServerConfig;
    const out = mapMcpServerConfig('s', config, {});
    expect(out.transport).toBe('sse');
    expect(out.bearerToken).toBeUndefined();
    expect(out.hasHeaders).toBe(false);
  });
});

describe('loadSessionMcpServers', () => {
  it('merges user mcp.json + plugin servers, and is fault-isolated on empty home', async () => {
    // Empty home + empty workdir: no mcp.json, no installed plugins → [].
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    const work = mkdtempSync(join(tmpdir(), 'kimi-work-'));
    const servers = await loadSessionMcpServers(home, work);
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(0);

    // A user-global mcp.json is picked up and mapped to the engine wire shape.
    writeFileSync(
      join(home, 'mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'node', args: ['s.js'] } } }),
    );
    const withUser = await loadSessionMcpServers(home, work);
    expect(withUser.map((s) => s.name)).toContain('fs');
    expect(withUser.find((s) => s.name === 'fs')?.command).toBe('node');
  }, 20_000);
});

describe('loadSessionHooks', () => {
  it('is fault-isolated on an empty home and picks up config [[hooks]]', async () => {
    // Empty home: no config.toml, no plugins → [].
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    expect(await loadSessionHooks(home)).toHaveLength(0);

    // A `[[hooks]]` section in config.toml is picked up on the wire shape.
    writeFileSync(
      join(home, 'config.toml'),
      ['[[hooks]]', 'event = "PreToolUse"', 'matcher = "^Write$"', 'command = "echo hi"', 'timeout = 10'].join('\n'),
    );
    const hooks = await loadSessionHooks(home);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: 'PreToolUse',
      matcher: '^Write$',
      command: 'echo hi',
      timeout: 10,
    });
  }, 20_000);
});

describe('loadSessionSystemPrompt', () => {
  it('assembles the coder profile prompt including the project AGENTS.md', async () => {
    // Isolated home (no user AGENTS.md) + a workDir carrying a project one.
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    const work = mkdtempSync(join(tmpdir(), 'kimi-work-'));
    writeFileSync(join(work, 'AGENTS.md'), 'PROJECT_MARKER_XYZ: always run the tests.');

    const prompt = await loadSessionSystemPrompt(home, work);
    expect(prompt).toBeDefined();
    // Project context is merged into the assembled prompt (parity with harness).
    expect(prompt).toContain('PROJECT_MARKER_XYZ');
    // And it is the real profile prompt, not a toy string (mentions AGENTS.md).
    expect(prompt).toContain('AGENTS.md');
  }, 30_000);
});
