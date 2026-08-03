/**
 * Test suite for the rust-transport `oauthService` + `authSummaryService`
 * (G3). Builds the klient over a `RustChannel` directly (registry.ts is the
 * other groups' load-time hub, still filling in) with an injected host auth
 * surface: a `KimiOAuthToolkit` pointed at a local loopback OAuth server with
 * a never-settling poll sleep, so the device flow is fully deterministic and
 * offline. The engine itself is never needed — these methods are host-side.
 */
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { KimiOAuthToolkit } from '@moonshot-ai/kimi-code-oauth';
import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createKlientFromChannel, type Klient } from '#/core/klient';
import { RustChannel } from '#/transports/rust/channel';
import type { RustHostServices } from '#/transports/rust/types';
// Self-registers oauthService + authSummaryService on the router.
import '#/transports/rust/services/auth';

const PROVIDER = 'managed:kimi-code';
const never = (): Promise<void> => new Promise(() => {});

function makeChannel(homeDir: string, toolkit: KimiOAuthToolkit): RustChannel {
  const host: RustHostServices = {
    homeDir,
    configPath: join(homeDir, 'config.toml'),
    auth: { toolkit },
  };
  return new RustChannel({
    rust: rustLoop as unknown as typeof rustLoop,
    host,
  });
}

function makeKlient(homeDir: string, toolkit: KimiOAuthToolkit): Klient {
  return createKlientFromChannel(makeChannel(homeDir, toolkit));
}

describe('rust auth transport', () => {
  let server: Server;
  let base: string;
  let homeDir: string;
  let toolkit: KimiOAuthToolkit;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-klient-auth-'));
    base = '';
    server = createServer((req, res) => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && url.startsWith('/api/oauth/device_authorization')) {
        res.end(
          JSON.stringify({
            user_code: 'ABCD-EFGH',
            device_code: 'device-123',
            verification_uri: `${base}/devices`,
            verification_uri_complete: `${base}/devices?user_code=ABCD-EFGH`,
            expires_in: 900,
            interval: 5,
          }),
        );
      } else if (req.method === 'POST' && url.startsWith('/api/oauth/token')) {
        // Keep the flow pending: the poll returns authorization_pending and the
        // injected sleep never settles, so the background login stays pending
        // until the test cancels it — deterministic, no timers left behind.
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'authorization_pending', error_description: 'awaiting approval' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    base = `http://127.0.0.1:${address.port}`;
    toolkit = new KimiOAuthToolkit({
      homeDir,
      flowConfig: { name: 'kimi-code', oauthHost: base, clientId: 'test-client' },
      sleep: never,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it('status reports not logged in without a token', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      await expect(klient.global.auth.status()).resolves.toEqual({ loggedIn: false });
    } finally {
      await klient.close();
    }
  });

  it('refreshOAuthProviderModels returns empty result with no managed provider', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      await expect(klient.global.auth.refreshProviderModels()).resolves.toEqual({
        changed: [],
        unchanged: [],
        failed: [],
      });
    } finally {
      await klient.close();
    }
  });

  it('authSummary.summarize returns [] without oauth providers', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      await expect(klient.global.auth.summarize()).resolves.toEqual([]);
    } finally {
      await klient.close();
    }
  });

  it('startLogin returns a pending device flow and getFlow snapshots it', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      const start = await klient.global.auth.startLogin();
      expect(start.status).toBe('pending');
      if (start.status !== 'pending') throw new Error('unreachable');
      expect(start.provider).toBe(PROVIDER);
      expect(start.flow_id).toMatch(/^oauth_/);
      expect(start.verification_uri).toBe(`${base}/devices`);
      expect(start.verification_uri_complete).toBe(`${base}/devices?user_code=ABCD-EFGH`);
      expect(start.user_code).toBe('ABCD-EFGH');
      expect(start.expires_in).toBe(900);
      expect(start.interval).toBe(5);
      expect(Number.isNaN(Date.parse(start.expires_at))).toBe(false);

      const flow = await klient.global.auth.flow();
      expect(flow?.status).toBe('pending');
      expect(flow?.user_code).toBe('ABCD-EFGH');
    } finally {
      await klient.close();
    }
  });

  it('cancelLogin aborts the pending flow', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      await klient.global.auth.startLogin();
      await expect(klient.global.auth.cancelLogin()).resolves.toEqual({
        cancelled: true,
        status: 'cancelled',
      });
      const flow = await klient.global.auth.flow();
      expect(flow?.status).toBe('cancelled');
      expect(flow?.resolved_at).toBeDefined();
    } finally {
      await klient.close();
    }
  });

  it('logout returns logged_out for the managed provider', async () => {
    const klient = makeKlient(homeDir, toolkit);
    try {
      await expect(klient.global.auth.logout()).resolves.toEqual({
        logged_out: true,
        provider: PROVIDER,
      });
    } finally {
      await klient.close();
    }
  });

  it('authSummary.ensureReady rejects when nothing is configured', async () => {
    const channel = makeChannel(homeDir, toolkit);
    try {
      await expect(
        channel.call({}, 'authSummaryService', 'ensureReady', [undefined]),
      ).rejects.toThrow(/No provider configured/);
    } finally {
      await channel.close();
    }
  });
});
