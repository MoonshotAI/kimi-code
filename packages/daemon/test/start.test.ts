/**
 * `startDaemon` + lock integration + DI wiring (ROADMAP P0.12 + P0.14).
 *
 * Bind to port 0 → ephemeral port; tmpdir lock path → no `~/.kimi` interference.
 * Tests share the assertion that the lock file appears alongside the listener
 * and vanishes on close, and that a second startDaemon raises DaemonLockedError.
 *
 * The DI graph end-to-end is exercised implicitly: every startDaemon call
 * constructs ILogService, IRestGateway, IEventService, IApprovalService,
 * IQuestionService, and ICoreProcessService in order. Failure modes there (missing
 * service, wrong ctor args) would surface as a startDaemon reject.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pino } from 'pino';

import {
  DaemonLockedError,
  IApprovalService,
  IConnectionRegistry,
  IEventService,
  ICoreProcessService,
  ILogService,
  IQuestionService,
  IRestGateway,
  ISessionClientsService,
  IWSBroadcastService,
  IWSGateway,
  startDaemon,
  type LockContents,
  type RunningDaemon,
} from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningDaemon[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-start-test-'));
  lockPath = join(tmpDir, 'lock');
  // Isolate KimiCore's `~/.kimi` lookup — bridge construction touches it via plugin discovery.
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-start-home-'));
});

afterEach(async () => {
  // Tear down every daemon spawned in the test in the order they were created.
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

async function spawn(): Promise<RunningDaemon> {
  const r = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: silentLogger(),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  running.push(r);
  return r;
}

describe('startDaemon — lock + healthz smoke', () => {
  it('acquires the lock and writes pid/port; close releases', async () => {
    const r = await spawn();

    expect(existsSync(lockPath)).toBe(true);
    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.pid).toBe(process.pid);
    expect(stored.port).toBe(0);

    expect(r.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await r.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('second startDaemon with the same lockPath throws DaemonLockedError', async () => {
    await spawn();
    await expect(spawn()).rejects.toBeInstanceOf(DaemonLockedError);
  });

  it('close() is idempotent', async () => {
    const r = await spawn();
    await r.close();
    await r.close(); // second call is a no-op (would throw on double-app.close otherwise)
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('startDaemon — DI container wiring', () => {
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

  it('CoreProcessService.rpc rejects after the daemon is closed (dispose cascade)', async () => {
    const r = await spawn();
    // Grab a bridge reference BEFORE close — after close the container is disposed
    // and a.get(ICoreProcessService) would throw on the dead InstantiationService.
    const bridge = r.services.invokeFunction((a) => a.get(ICoreProcessService));
    await r.close();
    await expect(bridge.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
  });
});

