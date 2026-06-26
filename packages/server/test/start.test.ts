/**
 * `startServer` + lock integration + DI wiring (ROADMAP P0.12 + P0.14).
 *
 * Bind to port 0 → ephemeral port; tmpdir lock path → no `~/.kimi` interference.
 * Tests share the assertion that the lock file appears alongside the listener
 * and vanishes on close, and that a second startServer raises ServerLockedError.
 *
 * The DI graph end-to-end is exercised implicitly: every startServer call
 * constructs ILogService, IRestGateway, IEventService, IApprovalService,
 * IQuestionService, and ICoreProcessService in order. Failure modes there (missing
 * service, wrong ctor args) would surface as a startServer reject.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pino } from 'pino';

import { listenWithPortRetry } from '../src/start';

import {
  ServerLockedError,
  IApprovalService,
  IConnectionRegistry,
  IEventService,
  ICoreProcessService,
  ILogService,
  IQuestionService,
  IRestGateway,
  IServerShutdownService,
  ISessionClientsService,
  IWSBroadcastService,
  IWSGateway,
  createServerLogger,
  startServer,
  type LockContents,
  type RunningServer,
} from '../src';
import { authHeaders, fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-start-test-'));
  lockPath = join(tmpDir, 'lock');
  // Isolate KimiCore's `~/.kimi` lookup — bridge construction touches it via plugin discovery.
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-start-home-'));
});

afterEach(async () => {
  // Tear down every server spawned in the test in the order they were created.
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

function silentLogger() {
  return pino({ level: 'silent' });
}

function listenOnPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Find `port` such that both `port` and `port + 1` are free to bind. */
async function allocateAdjacentFreePair(
  host = '127.0.0.1',
): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 30; i++) {
    const a = await listenOnPort(host, 0);
    const address = a.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await closeNetServer(a);
    if (port <= 0 || port >= 65535) continue;
    const probe = await listenOnPort(host, port + 1).catch(() => null);
    if (probe === null) continue;
    await closeNetServer(probe);
    return { port, next: port + 1 };
  }
  throw new Error('could not allocate an adjacent free port pair');
}

function fakeGateway(
  listen: (host: string, port: number) => Promise<string>,
): Parameters<typeof listenWithPortRetry>[0]['gateway'] {
  return { _serviceBrand: undefined, app: undefined, listen } as unknown as Parameters<
    typeof listenWithPortRetry
  >[0]['gateway'];
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  err.code = 'EADDRINUSE';
  return err;
}

async function spawn(): Promise<RunningServer> {
  const r = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: silentLogger(),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  running.push(r);
  return r;
}

describe('startServer — lock + healthz smoke', () => {
  it('acquires the lock and writes pid/port; close releases', async () => {
    const r = await spawn();

    expect(existsSync(lockPath)).toBe(true);
    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.pid).toBe(process.pid);
    expect(stored.host).toBe('127.0.0.1');
    expect(stored.port).toBe(0);

    expect(r.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await r.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('second startServer with the same lockPath throws ServerLockedError', async () => {
    await spawn();
    await expect(spawn()).rejects.toBeInstanceOf(ServerLockedError);
  });

  it('close() is idempotent', async () => {
    const r = await spawn();
    await r.close();
    await r.close(); // second call is a no-op (would throw on double-app.close otherwise)
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retries on port+1 and updates the lock when the requested port is held by a third party', async () => {
    // Occupy the requested port with a raw TCP server (a "third-party" process
    // from the server's point of view — it does NOT hold the lock).
    const { port, next } = await allocateAdjacentFreePair();
    const occupant = await listenOnPort('127.0.0.1', port);
    // Distinct lock path: the global single-instance lock is not what we are
    // testing here; the port conflict must come from the TCP bind alone.
    const thirdPartyLockPath = join(tmpDir, 'lock-third-party');
    try {
      const r = await startServer({
        serviceOverrides: [fixedTokenAuth()],
        host: '127.0.0.1',
        port,
        lockPath: thirdPartyLockPath,
        logger: silentLogger(),
        coreProcessOptions: { homeDir: bridgeHome },
      });
      running.push(r);

      // Bound to the next available port (>= next); the lock advertises it so
      // status/kill/ps work. On Windows a recently-closed probe port can linger
      // in TIME_WAIT, so the retry may land on port+2 instead of port+1.
      const boundPort = Number(new URL(r.address).port);
      expect(boundPort).toBeGreaterThanOrEqual(next);
      const stored = JSON.parse(readFileSync(thirdPartyLockPath, 'utf8')) as LockContents;
      expect(stored.port).toBe(boundPort);
    } finally {
      await closeNetServer(occupant);
    }
  });
});

describe('listenWithPortRetry', () => {
  it('returns the requested port when the first listen succeeds', async () => {
    const attempts: number[] = [];
    const gateway = fakeGateway(async (_host, port) => {
      attempts.push(port);
      return `http://127.0.0.1:${String(port)}`;
    });

    const result = await listenWithPortRetry({
      gateway,
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5000);
    expect(attempts).toEqual([5000]);
  });

  it('retries with port+1 on EADDRINUSE until a bind succeeds', async () => {
    const attempts: number[] = [];
    const gateway = fakeGateway(async (_host, port) => {
      attempts.push(port);
      if (port < 5002) throw addrInUse();
      return `http://127.0.0.1:${String(port)}`;
    });

    const result = await listenWithPortRetry({
      gateway,
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5002);
    expect(result.address).toBe('http://127.0.0.1:5002');
    expect(attempts).toEqual([5000, 5001, 5002]);
  });

  it('does not retry on non-EADDRINUSE errors', async () => {
    const attempts: number[] = [];
    const boom = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const gateway = fakeGateway(async (_host, port) => {
      attempts.push(port);
      throw boom;
    });

    await expect(
      listenWithPortRetry({ gateway, host: '127.0.0.1', port: 5000, logger: silentLogger() }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([5000]);
  });

  it('throws after exhausting maxRetries', async () => {
    const attempts: number[] = [];
    const gateway = fakeGateway(async (_host, port) => {
      attempts.push(port);
      throw addrInUse();
    });

    await expect(
      listenWithPortRetry({
        gateway,
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // initial attempt + 3 retries, then the cap throws.
    expect(attempts).toEqual([5000, 5001, 5002, 5003]);
  });

  it('does not walk ports when the requested port is 0 (ephemeral)', async () => {
    const attempts: number[] = [];
    const gateway = fakeGateway(async (_host, port) => {
      attempts.push(port);
      return 'http://127.0.0.1:54321';
    });

    const result = await listenWithPortRetry({
      gateway,
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
    });

    expect(result.port).toBe(0);
    expect(attempts).toEqual([0]);
  });
});

describe('createServerLogger', () => {
  it('uses an in-process pretty stream instead of pino worker transport', () => {
    const logger = createServerLogger({ level: 'info', pretty: true });
    const streamSym = (pino as unknown as { symbols: { streamSym: symbol } }).symbols.streamSym;
    const stream = logger[streamSym as keyof typeof logger] as unknown as NodeJS.WritableStream & {
      constructor?: { name?: string };
    };

    expect(stream.constructor?.name).not.toBe('ThreadStream');
    stream.end();
  });
});

describe('startServer — web assets', () => {
  it('serves web assets from the server root without shadowing API routes', async () => {
    const assetsDir = join(tmpDir, 'web-assets');
    rmSync(assetsDir, { recursive: true, force: true });
    mkdirSync(assetsDir);
    writeFileSync(join(assetsDir, 'index.html'), '<html><div id="app"></div></html>', 'utf8');
    writeFileSync(join(assetsDir, 'app.js'), 'console.log("kimi web");', 'utf8');

    const r = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath,
      logger: silentLogger(),
      coreProcessOptions: { homeDir: bridgeHome },
      webAssetsDir: assetsDir,
    });
    running.push(r);

    await expect(fetch(`${r.address}/`).then((res) => res.text())).resolves.toContain(
      '<div id="app"></div>',
    );
    await expect(fetch(`${r.address}/sessions/abc`).then((res) => res.text())).resolves.toContain(
      '<div id="app"></div>',
    );
    await expect(fetch(`${r.address}/app.js`).then((res) => res.text())).resolves.toBe(
      'console.log("kimi web");',
    );

    const health = await fetch(`${r.address}/api/v1/healthz`);
    await expect(health.json()).resolves.toMatchObject({ code: 0 });

    const openApi = await fetch(`${r.address}/openapi.json`, { headers: authHeaders() });
    expect(openApi.status).toBe(200);
    expect(openApi.headers.get('content-type')).toContain('application/json');
    await expect(openApi.json()).resolves.toMatchObject({
      info: {
        title: 'Kimi Code Server API',
      },
      paths: {
        '/api/v1/healthz': {},
        '/api/v1/sessions': {},
      },
    });

    const asyncApi = await fetch(`${r.address}/asyncapi.json`, { headers: authHeaders() });
    expect(asyncApi.status).toBe(200);
    expect(asyncApi.headers.get('content-type')).toContain('application/json');
    await expect(asyncApi.json()).resolves.toMatchObject({
      asyncapi: '3.1.0',
      defaultContentType: 'application/json',
      channels: {
        kimiCodeWebSocket: {
          address: '/api/v1/ws',
        },
      },
      operations: {
        receiveClientMessages: {
          action: 'receive',
        },
        sendServerMessages: {
          action: 'send',
        },
      },
    });
  });

  it('does not expose the Swagger UI while keeping /openapi.json available', async () => {
    const r = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '127.0.0.1',
      port: 0,
      lockPath,
      logger: silentLogger(),
      coreProcessOptions: { homeDir: bridgeHome },
    });
    running.push(r);

    const openApi = await fetch(`${r.address}/openapi.json`, { headers: authHeaders() });
    expect(openApi.status).toBe(200);

    const res = await fetch(`${r.address}/documentation`);
    expect(res.status).toBe(404);
  });
});

describe('startServer — DI container wiring', () => {
  it('exposes all DI services through running.services', async () => {
    const r = await spawn();
    // Every decorator should resolve. .get() would throw "No service registered"
    // if any were missing.
    r.services.invokeFunction((a) => {
      expect(a.get(ILogService)).toBeDefined();
      expect(a.get(IRestGateway)).toBeDefined();
      expect(a.get(IConnectionRegistry)).toBeDefined();
      expect(a.get(ISessionClientsService)).toBeDefined();
      expect(a.get(IEventService)).toBeDefined();
      expect(a.get(IWSBroadcastService)).toBeDefined();
      expect(a.get(IApprovalService)).toBeDefined();
      expect(a.get(IQuestionService)).toBeDefined();
      expect(a.get(IWSGateway)).toBeDefined();
      const bridge = a.get(ICoreProcessService);
      expect(bridge).toBeDefined();
      expect(typeof bridge.rpc).toBe('object');
      expect(typeof bridge.dispose).toBe('function');
    });
  });

  it('CoreProcessService.rpc rejects after the server is closed (dispose cascade)', async () => {
    const r = await spawn();
    // Grab a bridge reference BEFORE close — after close the container is disposed
    // and a.get(ICoreProcessService) would throw on the dead InstantiationService.
    const bridge = r.services.invokeFunction((a) => a.get(ICoreProcessService));
    await r.close();
    await expect(bridge.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
  });
});

describe('POST /api/v1/shutdown', () => {
  it('responds ok and triggers the shutdown service', async () => {
    let resolveCalled!: () => void;
    const called = new Promise<void>((res) => {
      resolveCalled = res;
    });
    const reasons: string[] = [];
    const fake = {
      _serviceBrand: undefined,
      requestShutdown: async (reason: string) => {
        reasons.push(reason);
        resolveCalled();
      },
    };

    const r = await startServer({
      host: '127.0.0.1',
      port: 0,
      lockPath,
      logger: silentLogger(),
      coreProcessOptions: { homeDir: bridgeHome },
      // Override the real shutdown service so the route does not exit the
      // test runner via `process.exit(0)`.
      serviceOverrides: [fixedTokenAuth(), [IServerShutdownService, fake] as const],
    });
    running.push(r);

    const res = await fetch(`${r.address}/api/v1/shutdown`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe(0);
    expect(body['data']).toEqual({ ok: true });

    // The route defers shutdown via setImmediate so the response can flush.
    await called;
    expect(reasons).toEqual(['api']);
  });

  it('registers a real shutdown service by default', async () => {
    const r = await spawn();
    const service = r.services.invokeFunction((a) => a.get(IServerShutdownService));
    expect(typeof service.requestShutdown).toBe('function');
  });
});
