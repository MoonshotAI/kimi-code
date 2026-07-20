/**
 * Scenario: App-scope watch of the user-level mcp.json.
 *
 * Valid content fires `onDidChange` (and a fresh `loadMcpServers` observes
 * the new servers — v2 loads mcp.json per session creation and has no cache
 * to invalidate); unparseable content logs a warning and suppresses the
 * event; blank content counts as valid, matching the loader's tolerance. The
 * watch rides real chokidar with a 150ms debounce, so assertions poll with
 * real timers. Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec
 * vitest run test/app/mcp/mcpConfigWatch.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { loadMcpServers } from '#/agent/mcp/config-loader';
import { IMcpConfigWatchService } from '#/app/mcp/mcpConfigWatch';
import { McpConfigWatchService } from '#/app/mcp/mcpConfigWatchService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await realSleep(25);
  }
}

describe('McpConfigWatchService', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let warnings: string[];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcp-watch-'));
    disposables = new DisposableStore();
    warnings = [];
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function createWatcher(): { events: number } {
    const state = { events: 0 };
    const log = {
      ...stubLog(),
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, log);
    ix.stub(IFileSystemStorageService, new FileStorageService(homeDir));
    ix.set(IMcpConfigWatchService, new SyncDescriptor(McpConfigWatchService));
    const watch = ix.get(IMcpConfigWatchService);
    disposables.add(watch.onDidChange(() => {
      state.events += 1;
    }));
    return state;
  }

  it('fires onDidChange for a valid write and a fresh load sees the new servers', async () => {
    const state = createWatcher();
    await realSleep(100);

    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { transport: 'http', url: 'https://docs.example.com' } } }),
      'utf8',
    );

    await waitFor(() => state.events === 1);
    const servers = await loadMcpServers({ cwd: homeDir, homeDir });
    expect(Object.keys(servers)).toEqual(['docs']);
    expect(warnings).toEqual([]);
  });

  it('warns and suppresses the event on invalid JSON', async () => {
    const state = createWatcher();
    await realSleep(100);

    await writeFile(join(homeDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    await waitFor(() => state.events === 1);

    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf8');
    await realSleep(400);
    expect(state.events).toBe(1);
    expect(warnings.some((message) => message.includes('invalid JSON'))).toBe(true);
  });

  it('treats blank content as a valid empty config change', async () => {
    const state = createWatcher();
    await realSleep(100);

    await writeFile(join(homeDir, 'mcp.json'), '   \n', 'utf8');

    await waitFor(() => state.events === 1);
    expect(warnings).toEqual([]);
  });
});
