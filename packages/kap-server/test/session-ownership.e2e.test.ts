/**
 * Multi-server session ownership — two kap-servers on ONE kimi home. Instance
 * A creates the session and holds its write lease; instance B's materializing
 * routes for the same session are answered with
 * `40921 session.held_by_peer` carrying the structured ownership details
 * (phase `routable` + A's address), so clients can redirect to the holder.
 * Closing A releases the lease and B takes over.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/session-ownership.e2e.test.ts`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionLeasePath } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
  stack?: string;
}

interface SessionWire {
  id: string;
}

describe('multi-server session ownership (session.held_by_peer → 40921)', () => {
  let home: string | undefined;
  let serverA: RunningServer | undefined;
  let serverB: RunningServer | undefined;

  afterEach(async () => {
    if (serverB !== undefined) {
      await serverB.close();
      serverB = undefined;
    }
    if (serverA !== undefined) {
      await serverA.close();
      serverA = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(): Promise<RunningServer> {
    return startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
      disableAuth: true,
    });
  }

  function base(server: RunningServer): string {
    return `http://127.0.0.1:${server.port}`;
  }

  async function getJson<T>(
    server: RunningServer,
    path: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base(server)}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  /** Boot A + B on the shared home and create a session owned by A. */
  async function bootPairWithSession(): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ownership-'));
    serverA = await boot();
    serverB = await boot();
    const res = await fetch(`${base(serverA)}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const body = (await res.json()) as Envelope<SessionWire>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  it(
    'B surfaces 40921 with routable ownership details, and A records its address in the lease file',
    async () => {
      const sessionId = await bootPairWithSession();
      const addressA = base(serverA as RunningServer);

      // Lease file: A advertises the URL it actually bound (post-listen swap
      // of the contact ref), so a contended peer knows where to redirect.
      const lease = JSON.parse(
        await readFile(`${sessionLeasePath(home as string, sessionId)}.owner.json`, 'utf8'),
      ) as Record<string, unknown>;
      expect(lease['address']).toBe(addressA);
      expect(typeof lease['lock_id']).toBe('string');

      // Per-route mapper path (prompts.ts `sendMappedError` switch).
      const prompts = await getJson<null>(
        serverB as RunningServer,
        `/api/v1/sessions/${sessionId}/prompts`,
      );
      expect(prompts.status).toBe(200);
      expect(prompts.body.code).toBe(ErrorCode.SESSION_HELD_BY_PEER);
      expect(prompts.body.code).toBe(40921);
      expect(prompts.body.details).toEqual({
        kind: 'held-by-peer',
        phase: 'routable',
        address: addressA,
      });

      // Global error-handler path (warnings resumes without a local switch).
      const warnings = await getJson<null>(
        serverB as RunningServer,
        `/api/v1/sessions/${sessionId}/warnings`,
      );
      expect(warnings.status).toBe(200);
      expect(warnings.body.code).toBe(ErrorCode.SESSION_HELD_BY_PEER);
      expect(warnings.body.details).toEqual({
        kind: 'held-by-peer',
        phase: 'routable',
        address: addressA,
      });
    },
    30_000,
  );

  it(
    'closing the holder releases the lease so the peer materializes the session instead of 40921',
    async () => {
      const sessionId = await bootPairWithSession();

      await (serverA as RunningServer).close();
      serverA = undefined;

      const warnings = await getJson<{ warnings: unknown[] }>(
        serverB as RunningServer,
        `/api/v1/sessions/${sessionId}/warnings`,
      );
      expect(warnings.status).toBe(200);
      expect(warnings.body.code).toBe(0);
      expect(warnings.body.code).not.toBe(ErrorCode.SESSION_HELD_BY_PEER);
      expect(warnings.body.data.warnings).toEqual([]);
    },
    30_000,
  );
});
