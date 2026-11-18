import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentEnvironmentBindingService,
  IAgentLifecycleService,
  IAgentToolRegistryService,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

describe('acp-server session/close', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-close-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'advertises the close capability and closes a live session',
    async () => {
      const c = await boot();
      const init = (await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} })) as {
        agentCapabilities?: { sessionCapabilities?: { close?: unknown } };
      };
      expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow();
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'closing an unknown sessionId is a best-effort no-op',
    async () => {
      const c = await boot();
      await expect(c.send('session/close', { sessionId: 'does-not-exist' })).resolves.toEqual({});
    },
    30_000,
  );

  async function mainBinding(sessionId: string) {
    const session = getLiveSessionById(client!.server.core.accessor, sessionId)!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(main.agentId)!;
    return agent.accessor.get(IAgentEnvironmentBindingService);
  }

  it('keeps local tools after repeated load/close and a terminal-style resume', async () => {
    const c = await boot();
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as { sessionId: string };
    for (let i = 0; i < 2; i++) {
      await c.send('session/load', { sessionId: created.sessionId, cwd: homeDir, mcpServers: [] });
    }
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe('local');
    await c.send('session/close', { sessionId: created.sessionId });

    expect(await c.server.klient.session(created.sessionId).restore()).toBe(true);
    expect((await mainBinding(created.sessionId)).current.environmentId).toBe('local');
    const session = getLiveSessionById(c.server.core.accessor, created.sessionId)!;
    const main = await ensureMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(main.agentId)!;
    const tool = agent.accessor.get(IAgentToolRegistryService).resolve('Bash');
    expect(tool, 'Tool "Bash" not found').toBeDefined();
    const execution = await tool!.resolveExecution({ command: 'printf local_shell_ok' });
    if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'local-after-acp-preview',
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.output)).toContain('local_shell_ok');
  }, 30_000);


});
