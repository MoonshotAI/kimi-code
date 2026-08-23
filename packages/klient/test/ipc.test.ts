import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { IMcpManagementService } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

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
    app,
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

  it('completeAuth outlives the channel default call timeout', async () => {
    const socketPath = await setup();
    // A slow engine-side wait: without the facade's per-call deadline the
    // channel's default would kill the long poll mid-flight.
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
      );
    const cancelSpy = vi
      .spyOn(management, 'cancelServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
      );
    const klient = createKlient({ socketPath, callTimeoutMs: 25 });
    try {
      // completeAuth passes the engine wait + margin as its per-call deadline,
      // so the 200ms wait resolves instead of dying at the 25ms default.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 100 }),
      ).resolves.toBeUndefined();
      // Calls without the override still die at the channel default.
      await expect(klient.global.mcp.cancelAuth({ flowId: 'flow-1' })).rejects.toThrow(
        'call timed out after 25ms',
      );
    } finally {
      completeSpy.mockRestore();
      cancelSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });

  it('completeAuth clamps a near-max timeoutMs instead of overflowing the call timer', async () => {
    const socketPath = await setup();
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      );
    const klient = createKlient({ socketPath, callTimeoutMs: 25 });
    try {
      // timeoutMs at the contract max plus the facade margin would overflow
      // Node's 32-bit setTimeout into ~1ms; the clamp keeps the call alive
      // until the engine-side wait resolves.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 2 ** 31 - 1 }),
      ).resolves.toBeUndefined();
      expect(completeSpy).toHaveBeenCalled();
    } finally {
      completeSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });
});
