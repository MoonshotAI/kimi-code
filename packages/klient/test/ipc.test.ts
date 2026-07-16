import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient, serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

defineKlientConformance('ipc', async () => {
  const { homeDir, app } = await makeEngine();
  const socketPath = join(homeDir, 'klient.sock');
  const host = await serveKlientIpc({ scope: app, socketPath });
  const klient = createKlient({ socketPath });
  return {
    klient,
    cleanup: async () => {
      await klient.close();
      await host.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('ipc transport specifics', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;

  async function setup(opts: { token?: string } = {}): Promise<string> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, token: opts.token });
    return socketPath;
  }

  async function teardown(): Promise<void> {
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it('rejects calls when the socket path does not exist', async () => {
    const klient = createKlient({ socketPath: join(tmpdir(), 'klient-no-such.sock') });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();
  });

  it('rejects calls made after close', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    await klient.global.env();
    await klient.close();
    // env() is served from its frozen-snapshot cache after the first call, so
    // probe the closed channel with an uncached method instead.
    await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    await teardown();
  });

  it('drops clients whose hello token mismatches', async () => {
    const socketPath = await setup({ token: 'right' });
    const klient = createKlient({ socketPath, token: 'wrong' });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();

    const ok = createKlient({ socketPath, token: 'right' });
    await expect(ok.global.env()).resolves.toMatchObject({ platform: process.platform });
    await ok.close();
    await teardown();
  });
});
