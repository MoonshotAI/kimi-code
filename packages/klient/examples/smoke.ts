/**
 * Assert-based smoke check for klient against an in-process engine (memory
 * transport). Exercises the `global` facade end-to-end: env snapshot, read
 * models, a workspace round-trip, a provider set/delete round-trip with the
 * `kosong.providers.changed` event, an anonymous-provider set/delete
 * round-trip with the `kosong.models.changed` event, the read-only model
 * catalog, and the error path.
 *
 *   pnpm -C packages/klient smoke
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { createKlient } from '@moonshot-ai/klient/memory';

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-smoke-'));
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    const klient = createKlient({ scope: app });

    const env = await klient.global.env();
    assert(env.platform.length > 0 && env.homeDir.length > 0, 'env snapshot is populated');
    console.log('[ok] env');

    const page = await klient.global.sessions.list({ limit: 5 });
    assert(Array.isArray(page.items), 'sessions.list returns a page');
    console.log('[ok] sessions.list ->', page.items.length);

    const workspaces = await klient.global.workspaces.list();
    assert(Array.isArray(workspaces), 'workspaces.list returns an array');
    console.log('[ok] workspaces.list ->', workspaces.length);

    // Provider round-trip with the klient-level event.
    const seen: string[] = [];
    const sub = klient.events.on('kosong.providers.changed', (event) => {
      seen.push(...event.added, ...event.changed, ...event.removed);
    });
    const name = '__klient_smoke__';
    await klient.global.kosong.addProvider(name, {
      type: 'openai',
      auth: { method: 'api-key', apiKey: 'smoke-key' },
    });
    const got = await klient.global.kosong.getProvider(name);
    assert(got !== undefined, 'kosong.getProvider returns the new provider');
    const deadline = Date.now() + 5_000;
    while (!seen.includes(name) && Date.now() < deadline) await tick(25);
    assert(seen.includes(name), 'kosong.providers.changed fired for the new provider');
    await klient.global.kosong.removeProvider(name);
    sub.dispose();
    console.log('[ok] kosong addProvider/getProvider/removeProvider + kosong.providers.changed');

    // Anonymous provider round-trip (single-model, all fields inline).
    const seenModels: string[] = [];
    const modelSub = klient.events.on('kosong.models.changed', (event) => {
      seenModels.push(...event.added, ...event.changed, ...event.removed);
    });
    const modelId = '__klient_smoke__';
    await klient.global.kosong.addProvider({
      id: modelId,
      model: 'smoke-model',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      auth: { method: 'api-key', apiKey: 'smoke-key' },
      maxContextSize: 8192,
    });
    const modelDeadline = Date.now() + 5_000;
    while (!seenModels.includes(modelId) && Date.now() < modelDeadline) await tick(25);
    assert(seenModels.includes(modelId), 'kosong.models.changed fired for the new model');
    await klient.global.kosong.removeProvider(modelId);
    modelSub.dispose();
    console.log('[ok] kosong anonymous addProvider/removeProvider + kosong.models.changed');

    // The read-only catalog projection over the same materialization.
    assert(
      Array.isArray(await klient.global.kosong.listModels()),
      'kosong.listModels returns an array',
    );
    assert(
      Array.isArray(await klient.global.kosong.listProviders()),
      'kosong.listProviders returns an array',
    );
    console.log('[ok] kosong.listModels / listProviders');

    const config = await klient.global.config.getAll();
    assert(typeof config === 'object' && config !== null, 'config.getAll returns an object');
    console.log('[ok] config.getAll');

    assert(Array.isArray(await klient.global.flags.list()), 'flags.list returns an array');
    assert(Array.isArray(await klient.global.plugins.list()), 'plugins.list returns an array');
    const auth = await klient.global.auth.status();
    assert(typeof auth.loggedIn === 'boolean', 'auth.status returns a status');
    console.log('[ok] flags / plugins / auth');

    let rpcError: { name: string; code?: number } | undefined;
    try {
      await klient.global.plugins.info('__definitely_missing__');
    } catch (error) {
      rpcError = error as { name: string; code?: number };
    }
    assert(rpcError !== undefined, 'missing plugin surfaces an error');
    console.log('[ok] error path ->', rpcError.name, rpcError.code);

    await klient.close();
    console.log('smoke: OK');
  } finally {
    app.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
