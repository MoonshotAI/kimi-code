import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';
import type { SDKRPC } from '../../src/rpc/sdk-api';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('KimiCore.createSession MCP overrides', () => {
  it('merges caller-provided MCP servers into the session config', async () => {
    const homeDir = await makeTempDir('kimi-home-');
    const workDir = await makeTempDir('kimi-work-');
    const sdk: SDKRPC = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async () => ({ decision: 'cancelled' as const })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    };
    const core = new KimiCore(async () => sdk, { homeDir });

    const summary = await core.createSession({
      id: 'ses_acp_mcp',
      workDir,
      mcpServers: {
        client: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          enabled: false,
        },
      },
    });

    expect(core.sessions.get(summary.id)?.options.mcpConfig?.servers).toEqual({
      client: {
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        enabled: false,
      },
    });
    await core.closeSession({ sessionId: summary.id });
  });

  it('merges caller-provided MCP servers when resuming a session', async () => {
    const homeDir = await makeTempDir('kimi-home-');
    const workDir = await makeTempDir('kimi-work-');
    const sdk: SDKRPC = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async () => ({ decision: 'cancelled' as const })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    };
    const core = new KimiCore(async () => sdk, { homeDir });

    const summary = await core.createSession({
      id: 'ses_acp_resume_mcp',
      workDir,
    });
    await core.closeSession({ sessionId: summary.id });

    await core.resumeSession({
      sessionId: summary.id,
      mcpServers: {
        client: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          enabled: false,
        },
      },
    });

    expect(core.sessions.get(summary.id)?.options.mcpConfig?.servers).toEqual({
      client: {
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        enabled: false,
      },
    });
    await core.closeSession({ sessionId: summary.id });
  });

  it('merges caller-provided MCP servers when forking a session', async () => {
    const homeDir = await makeTempDir('kimi-home-');
    const workDir = await makeTempDir('kimi-work-');
    const sdk: SDKRPC = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async () => ({ decision: 'cancelled' as const })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    };
    const core = new KimiCore(async () => sdk, { homeDir });

    const source = await core.createSession({
      id: 'ses_acp_fork_source',
      workDir,
    });
    await core.closeSession({ sessionId: source.id });

    const forked = await core.forkSession({
      sessionId: source.id,
      id: 'ses_acp_fork_target',
      mcpServers: {
        client: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          enabled: false,
        },
      },
    });

    expect(core.sessions.get(forked.id)?.options.mcpConfig?.servers).toEqual({
      client: {
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        enabled: false,
      },
    });
    await core.closeSession({ sessionId: forked.id });
  });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
