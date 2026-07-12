import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

interface AvailableCommand {
  readonly name: string;
}

describe('acp-server skills / available commands', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-skills-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'session/new pushes an available_commands_update containing the builtin commands',
    async () => {
      const c = await boot();
      await c.send('session/new', { cwd: homeDir, mcpServers: [] });

      const notification = await c.waitForSessionUpdate('available_commands_update', 10_000);
      const params = notification.params as {
        update: { availableCommands: readonly AvailableCommand[] };
      };
      const names = params.update.availableCommands.map((command) => command.name);
      // The ACP-owned builtin commands are always advertised.
      expect(names).toContain('compact');
      expect(names).toContain('status');
      expect(names).toContain('help');
    },
    30_000,
  );
});
