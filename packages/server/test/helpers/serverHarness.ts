/**
 * Reusable e2e server harness with token support (ROADMAP M0.2 / M5.1).
 *
 * Wraps `startServer` with an isolated tmp lock + home dir and exposes helpers
 * (`authedFetch` / `authedWs`) that carry an `Authorization: Bearer <token>`.
 *
 * From M5.1 the server enforces bearer auth, so `boot()` injects a fixed-token
 * `IAuthTokenService` (default token `test-token`) via `serviceOverrides` by
 * default — keeping harness-based tests transparent. A caller-supplied
 * `IAuthTokenService` override still wins (serviceOverrides are last-wins), so
 * tests that need a custom impl can pass one explicitly. For tests that boot
 * `startServer` directly, use the exported {@link fixedTokenAuth} /
 * {@link withAuth} / {@link authHeaders} helpers to inject the same fixed token
 * and carry it on each request.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceIdentifier } from '@moonshot-ai/agent-core';
import { pino } from 'pino';
import { WebSocket } from 'ws';

import { startServer, type RunningServer, type ServerStartOptions } from '../../src';
import { IAuthTokenService } from '../../src/services/auth/authTokenService';
import type { IAuthTokenService as IAuthTokenServiceType } from '../../src/services/auth/authTokenService';

type ServiceOverride = readonly [ServiceIdentifier<unknown>, unknown];

/** Default deterministic token used when a test does not supply one. */
const DEFAULT_TOKEN = 'test-token';

/**
 * Build a `[IAuthTokenService, impl]` override pair that accepts a single fixed
 * `token`. Pass it into `startServer({ serviceOverrides: [fixedTokenAuth()] })`
 * (or `boot({ serviceOverrides: [fixedTokenAuth()] })`) so a test can
 * authenticate with `Authorization: Bearer test-token` — or any custom `token`.
 *
 * `getToken` returns the fixed token so callers that read it back (e.g. WS
 * subprotocol helpers) stay consistent; `isValid` accepts only that token.
 */
export function fixedTokenAuth(token: string = DEFAULT_TOKEN): ServiceOverride {
  const impl: IAuthTokenServiceType = {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: async (candidate) => candidate === token,
  };
  return [IAuthTokenService, impl];
}

/** An `Authorization: Bearer <token>` header bag, for spreading into `headers`. */
export function authHeaders(token: string = DEFAULT_TOKEN): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Merge `Authorization: Bearer <token>` into a `fetch` `RequestInit`, preserving
 * caller-supplied headers. A caller-supplied `Authorization` wins, so tests that
 * need to send a wrong/no token can still do so explicitly.
 */
export function withAuth(init: RequestInit = {}, token: string = DEFAULT_TOKEN): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
}

/**
 * WS subprotocol prefix that carries the bearer token during the upgrade.
 * Hardcoded here as a literal for M0; `WS_BEARER_PROTOCOL_PREFIX` is introduced
 * in M3.1 and may replace this literal when the WS auth seam lands.
 */
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export interface BootOptions {
  /** Bearer token attached by `authedFetch` / `authedWs`. Defaults to `'test-token'`. */
  token?: string;
  /**
   * Generic pass-through to `startServer({ serviceOverrides })`. The auth seam:
   * from M2.1 on, callers inject `[IAuthTokenService, fixedTokenImpl]` here.
   * Defaults to `[]`.
   */
  serviceOverrides?: ServerStartOptions['serviceOverrides'];
  /** Bind host. Defaults to `'127.0.0.1'`. */
  host?: string;
  /** Bind port. Defaults to `0` (ephemeral). */
  port?: number;
}

export interface ServerHarness {
  /** The underlying `startServer` result. */
  readonly server: RunningServer;
  /** Raw address returned by `startServer`, e.g. `http://127.0.0.1:51234`. */
  readonly address: string;
  /** HTTP base URL, e.g. `http://127.0.0.1:51234`. */
  readonly baseUrl: string;
  /** WebSocket URL for the v1 endpoint, e.g. `ws://127.0.0.1:51234/api/v1/ws`. */
  readonly wsUrl: string;
  /** The bearer token this harness attaches to requests. */
  readonly token: string;
  /**
   * `fetch` against `baseUrl + path`, merging `Authorization: Bearer <token>`
   * into the request headers. Caller-supplied headers win on conflict.
   */
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Open a `ws` WebSocket to `wsUrl`, offering subprotocol
   * `kimi-code.bearer.<token>` and an `Authorization: Bearer <token>` header.
   * In M0 the server ignores both; the connection still opens.
   */
  authedWs(): WebSocket;
  /** Tear down this server and terminate any sockets opened via `authedWs`. */
  close(): Promise<void>;
}

/** Every harness produced by `boot()`, for suite-level cleanup via `closeAll()`. */
const opened = new Set<ServerHarness>();

function deriveHttpPort(address: string): string {
  const port = new URL(address).port;
  if (port === '') {
    throw new Error(`cannot derive port from server address: ${address}`);
  }
  return port;
}

/**
 * Boot an isolated `startServer` for e2e use.
 *
 * Creates a tmp `lockPath` + isolated home dir (mirroring `start.test.ts`),
 * binds to `127.0.0.1:0` by default, and tracks the result for `closeAll()`.
 */
export async function boot(opts: BootOptions = {}): Promise<ServerHarness> {
  const token = opts.token ?? DEFAULT_TOKEN;
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  // Inject a fixed-token `IAuthTokenService` by default so harness-based tests
  // stay transparent (`authedFetch` / `authedWs` already carry `test-token`).
  // The fixed impl is placed FIRST so an explicit caller-supplied
  // `IAuthTokenService` override still wins (serviceOverrides are last-wins).
  const serviceOverrides: ServerStartOptions['serviceOverrides'] = [
    fixedTokenAuth(token),
    ...(opts.serviceOverrides ?? []),
  ];

  const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-harness-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-server-harness-home-'));
  const lockPath = join(tmpDir, 'lock');

  const server = await startServer({
    host,
    port,
    lockPath,
    serviceOverrides,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir },
  });

  const httpPort = deriveHttpPort(server.address);
  const baseUrl = `http://${host}:${httpPort}`;
  const wsUrl = `ws://${host}:${httpPort}/api/v1/ws`;

  const sockets = new Set<WebSocket>();
  let closed = false;

  const harness: ServerHarness = {
    server,
    address: server.address,
    baseUrl,
    wsUrl,
    token,

    authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      // Caller-supplied Authorization wins on conflict.
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },

    authedWs(): WebSocket {
      const ws = new WebSocket(wsUrl, [`${WS_BEARER_PROTOCOL_PREFIX}${token}`], {
        headers: { Authorization: `Bearer ${token}` },
      });
      sockets.add(ws);
      const drop = (): void => {
        sockets.delete(ws);
      };
      ws.once('close', drop);
      ws.once('error', drop);
      return ws;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      opened.delete(harness);

      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          // ignore — best-effort teardown
        }
      }
      sockets.clear();

      try {
        await server.close();
      } catch {
        // ignore — best-effort teardown
      }
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };

  opened.add(harness);
  return harness;
}

/** Close every harness produced by `boot()`. Intended for `afterEach` cleanup. */
export async function closeAll(): Promise<void> {
  const pending = [...opened];
  await Promise.all(pending.map((harness) => harness.close()));
}
