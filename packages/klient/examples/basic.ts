/**
 * Minimal end-to-end example driving an in-process engine with klient's
 * `global` facade over the memory transport (calls and events never leave
 * the process — same facade either way).
 *
 * Run it (the engine sources need the decorators tsconfig + raw-text loader):
 *   pnpm -C packages/klient exec tsx --tsconfig ./tsconfig.examples.json \
 *     --import ../../build/register-raw-text-loader.mjs examples/basic.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { createKlient } from '@moonshot-ai/klient/memory';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-basic-'));
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    const klient = createKlient({ scope: app });

    // 1) Aggregated host snapshot.
    const env = await klient.global.env();
    console.log('[env]      platform/homeDir   ->', env.platform, env.homeDir);

    // 2) Read models.
    const sessions = await klient.global.sessions.list({});
    console.log('[sessions] list               ->', sessions.items.length, 'sessions');
    const workspaces = await klient.global.workspaces.list();
    console.log('[workspaces] list             ->', workspaces.length, 'workspaces');
    const providers = await klient.global.kosong.listProviders();
    console.log('[providers] list              ->', providers.length, 'providers');

    // 3) Events — klient-level forwarding (no onDid*/onWill* in sight).
    const sub = klient.events.on('kosong.providers.changed', (event) => {
      console.log(
        '[event]    kosong.providers.changed  -> +%s -%s ~%s',
        event.added,
        event.removed,
        event.changed,
      );
    });
    await klient.global.kosong.addProvider('__klient_example__', {
      type: 'openai',
      auth: { method: 'api-key', apiKey: 'example-key' },
    });
    await klient.global.kosong.removeProvider('__klient_example__');
    sub.dispose();

    // 4) Error path — a missing plugin surfaces an error.
    try {
      await klient.global.plugins.info('__definitely_missing__');
    } catch (error) {
      const e = error as { name: string; code?: number };
      console.log('[error]    plugins.info        ->', e.name, e.code);
    }

    await klient.close();
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
