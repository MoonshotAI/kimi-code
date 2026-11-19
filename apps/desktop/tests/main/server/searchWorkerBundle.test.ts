import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsdown';
import { expect, it } from 'vitest';

it('ships a runnable search worker that indexes and removes session documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-search-bundle-'));
  let worker: Worker | undefined;
  try {
    const desktop = fileURLToPath(new URL('../../..', import.meta.url));
    await build({ cwd: desktop, config: join(desktop, 'tsdown.config.ts'), outDir: join(root, 'out'), logLevel: 'silent' });
    worker = new Worker(join(root, 'out', 'search-worker.cjs'), {
      workerData: { dir: join(root, 'index'), bootSalt: 'bundle-test' },
    });
    const running = worker;
    const receive = (id?: number) => new Promise<unknown>((resolve, reject) => {
      const onError = (error: Error) => {
        running.off('message', onMessage);
        reject(error);
      };
      const onMessage = (message: { id?: number; type: string; result?: unknown; error?: { message: string } }) => {
        if (id === undefined ? message.type !== 'ready' : message.id !== id) return;
        running.off('message', onMessage);
        running.off('error', onError);
        if (message.type === 'error') reject(new Error(message.error?.message));
        else resolve(message.result);
      };
      running.on('message', onMessage);
      running.once('error', onError);
    });
    await receive();
    let id = 0;
    const call = (type: string, params?: unknown) => {
      const result = receive(++id);
      running.postMessage({ id, v: 1, type, params });
      return result;
    };
    await call('open');
    const dir = join(root, 'session');
    await mkdir(dir);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ title: 'Packaged search fixture' }));
    await call('sync', { sessions: [{ id: 'fixture', workspaceId: 'workspace', updatedAt: Date.now(), dir }] });
    expect(await call('status')).toMatchObject({ sessions: 1, documents: 1 });
    await rm(dir, { recursive: true });
    await call('sync', { sessions: [] });
    expect(await call('status')).toMatchObject({ sessions: 0, documents: 0 });
    await call('close');
  } finally {
    await worker?.terminate();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
