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
    'session/new pushes an available_commands_update without unhandled builtin commands',
    async () => {
      const c = await boot();
      await c.send('session/new', { cwd: homeDir, mcpServers: [] });

      const notification = await c.waitForSessionUpdate('available_commands_update', 10_000);
      const params = notification.params as {
        update: { availableCommands: readonly AvailableCommand[] };
      };
      const names = params.update.availableCommands.map((command) => command.name);
      // Builtin commands are not advertised until the host can execute them;
      // only invocable skills are listed.
      expect(names).not.toContain('compact');
      expect(names).not.toContain('status');
      expect(names).not.toContain('help');
    },
    30_000,
  );
});
