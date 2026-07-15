/**
 * Minimal end-to-end example driving a running `kap-server` over `/api/v2` with
 * klient — core + session scopes, both the generic typed proxy and the
 * explicit `SessionIndexClient`, plus the error path.
 *
 * Run against a local dev server (auth bypassed for dev):
 *   pnpm dev:server --dangerous-bypass-auth
 *   pnpm -C packages/klient exec tsx examples/basic.ts
 */
import { HttpChannel, Klient, SessionIndexClient } from '@moonshot-ai/klient';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

const BASE = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';

async function createSessionViaV1(cwd: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { cwd } }),
  });
  const env = (await res.json()) as { code: number; data: { id: string } };
  if (env.code !== 0) throw new Error(`create session failed: ${JSON.stringify(env)}`);
  return env.data.id;
}

async function main(): Promise<void> {
  const client = new Klient({ url: BASE });

  // 1) Generic typed proxy — core scope. The token carries type + channel name.
  const page = await client.core(ISessionIndex).list({});
  console.log('[core]    sessionIndex.list      ->', page.items.length, 'sessions');

  // 2) Explicit impl — same interface, hand-written class on a bound channel.
  const index: ISessionIndex = new SessionIndexClient(
    new HttpChannel({ baseUrl: `${BASE}/api/v2/sessionIndex` }),
  );
  const page2 = await index.list({});
  console.log('[core]    SessionIndexClient.list ->', page2.items.length, 'sessions (explicit)');

  // 3) Session scope — create a session via /api/v1, then read metadata via v2.
  const id = await createSessionViaV1('/tmp/klient-example');
  console.log('[v1]      created session         ->', id);
  const meta = await client.session(id).service(ISessionMetadata).read();
  console.log('[session] sessionMetadata.read   ->', {
    id: meta.id,
    cwd: meta.cwd,
    archived: meta.archived,
  });

  // 4) Error path — unknown method -> RPCError(40001).
  try {
    await (client.core(ISessionIndex) as unknown as { nope(): Promise<unknown> }).nope();
  } catch (err) {
    const e = err as { name: string; code: number };
    console.log('[error]   unknown method         ->', e.name, e.code);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
