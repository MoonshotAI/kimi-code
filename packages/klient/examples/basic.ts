/**
 * Minimal end-to-end example driving a running `kap-server` with klient's
 * `global` facade over the HTTP transport (events ride a lazily opened WS —
 * same facade either way).
 *
 * Run against a local dev server (auth bypassed for dev):
 *   pnpm dev:server --dangerous-bypass-auth
 *   pnpm -C packages/klient exec tsx examples/basic.ts
 */
import { createKlient } from '@moonshot-ai/klient/http';

const BASE = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';

async function main(): Promise<void> {
  const klient = createKlient({ url: BASE });

  // 1) Aggregated host snapshot.
  const env = await klient.global.env();
  console.log('[env]      platform/homeDir   ->', env.platform, env.homeDir);

  // 2) Read models.
  const sessions = await klient.global.sessions.list({});
  console.log('[sessions] list               ->', sessions.items.length, 'sessions');
  const workspaces = await klient.global.workspaces.list();
  console.log('[workspaces] list             ->', workspaces.length, 'workspaces');
  const providers = await klient.global.providers.list();
  console.log('[providers] list              ->', Object.keys(providers).length, 'providers');

  // 3) Events — klient-level forwarding (no onDid*/onWill* in sight).
  const sub = klient.events.on('providers.changed', (event) => {
    console.log('[event]    providers.changed  -> +%s -%s ~%s', event.added, event.removed, event.changed);
  });
  await klient.global.providers.set({
    name: '__klient_example__',
    config: { apiKey: 'example-key' },
  });
  await klient.global.providers.delete('__klient_example__');
  sub.dispose();

  // 4) Error path — a missing plugin surfaces as RPCError with the server's code.
  try {
    await klient.global.plugins.info('__definitely_missing__');
  } catch (error) {
    const e = error as { name: string; code?: number };
    console.log('[error]    plugins.info        ->', e.name, e.code);
  }

  await klient.close();
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
