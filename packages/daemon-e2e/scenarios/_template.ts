#!/usr/bin/env node
/**
 * Template scenario — copy-paste starting point.
 *
 * Usage:
 *   DAEMON_URL=http://127.0.0.1:7878 npx tsx scenarios/_template.ts
 *
 * (`tsx` is a workspace devDependency; it handles the `.ts` imports below.
 * Plain `node` won't resolve them.)
 *
 * Each scenario:
 *   1. Constructs a `DaemonClient` pointed at the live daemon.
 *   2. Opens an HTTP session and a WS connection.
 *   3. Subscribes to the session, drives some flow, asserts on the result.
 *   4. Cleans up — close the WS, delete the session.
 */
import { DaemonClient } from '../src/index';

const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';

async function main() {
  const client = new DaemonClient({
    baseUrl: DAEMON_URL,
    logger: (level, msg, meta) => console.log(`[${level}] ${msg}`, meta ?? ''),
  });

  let sid: string | undefined;
  try {
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    sid = session.id;

    await client.connect();
    await client.subscribe(sid);

    // TODO: drive your scenario here. Examples:
    //   - await client.submitAndWait(sid, { content: [{ type: 'text', text: '...' }] });
    //   - client.onApprovalRequested((req) => ({ decision: 'approved' }));
    //   - const final = await client.waitForFrame(f => f.type === 'turn.ended');

    console.log('✓ scenario template ran (no assertions)');
  } finally {
    try {
      if (sid) await client.deleteSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error('✗ scenario failed:', err);
  process.exit(1);
});
