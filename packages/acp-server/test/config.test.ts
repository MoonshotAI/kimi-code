import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

interface ConfigOption {
  readonly id: string;
  readonly currentValue: string;
}

interface NewSessionResult {
  readonly sessionId: string;
  readonly configOptions: readonly ConfigOption[];
}

describe('acp-server config surface', () => {
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
    homeDir = await mkdtemp(join(tmpdir(), 'acp-config-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function newSession(): Promise<NewSessionResult> {
    return (await client!.send('session/new', {
      cwd: homeDir,
      mcpServers: [],
    })) as NewSessionResult;
  }

  it(
    'session/new advertises mode + model pickers (no thinking without a model)',
    async () => {
      await boot();
      const { configOptions } = await newSession();
      const ids = configOptions.map((o) => o.id);
      expect(ids).toContain('mode');
      expect(ids).toContain('model');
      expect(ids).not.toContain('thinking');
      const mode = configOptions.find((o) => o.id === 'mode')!;
      expect(mode.currentValue).toBe('default');
    },
    30_000,
  );

  it(
    'session/set_config_option mode updates the returned snapshot',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      const result = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'yolo',
      })) as { configOptions: readonly ConfigOption[] };
      const mode = result.configOptions.find((o) => o.id === 'mode')!;
      expect(mode.currentValue).toBe('yolo');
    },
    30_000,
  );

  it(
    'session/set_config_option rejects an unknown modeId',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'mode',
          value: 'bogus',
        }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'session/set_config_option rejects an unknown configId',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'nope',
          value: 'x',
        }),
      ).rejects.toThrow();
    },
    30_000,
  );
});
