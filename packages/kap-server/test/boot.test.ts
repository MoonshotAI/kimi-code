import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IAppendLogStore,
  IAgentLifecycleService,
  IAgentTaskService,
  IAtomicDocumentStore,
  IBootstrapService,
  IExternalHooksRunnerService,
  IFileSystemStorageService,
  IHostRequestHeaders,
  ILogService,
  ISessionLockService,
  ISessionManager,
  ISessionContext,
  ISessionIndexMirror,
  ISessionMetadata,
  IWireService,
  InMemoryStorageService,
  IOAuthToolkit,
  ITelemetryService,
  noopTelemetryService,
  StorageError,
  StorageErrors,
  SessionLockService,
  setUnexpectedErrorHandler,
  resetUnexpectedErrorHandler,
} from '@moonshot-ai/agent-core-v2';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { listenWithPortRetry, type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

describe('server-v2 boot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('boots agent-core-v2 and serves the basic /api/v1 routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const base = `http://127.0.0.1:${server.port}`;

    const healthz = await fetch(`${base}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
    const healthBody = await healthz.json() as {
      code: number;
      data: { ok: boolean };
      request_id: string;
    };
    expect(healthBody.code).toBe(0);
    expect(healthBody.data.ok).toBe(true);
    expect(typeof healthBody.request_id).toBe('string');

    const meta = await authedFetch(server, base, '/api/v1/meta');
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      code: number;
      data: { server_id: string; server_version: string; capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(typeof metaBody.data.server_id).toBe('string');
    expect(typeof metaBody.data.server_version).toBe('string');
    expect(metaBody.data.capabilities).toBeDefined();

    const auth = await authedFetch(server, base, '/api/v1/auth');
    expect(auth.status).toBe(200);
    const authBody = await auth.json() as {
      code: number;
      data: { models_ready: boolean; providers_count: number };
    };
    expect(authBody.code).toBe(0);
    expect(typeof authBody.data.models_ready).toBe('boolean');
    expect(authBody.data.providers_count).toBeGreaterThanOrEqual(0);

    const oauthPoll = await authedFetch(server, base, '/api/v1/oauth/login');
    expect(oauthPoll.status).toBe(200);
    const oauthBody = await oauthPoll.json() as { code: number; data: null };
    expect(oauthBody.code).toBe(0);
    expect(oauthBody.data).toBeNull();
  });

  it('reports opts.serverVersion as server_version instead of the package version', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-version-'));
    server = await startServer({
      hostIdentity: {
        productName: 'test-host',
        version: '9.9.9-host',
        platform: 'test_platform',
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      serverVersion: '9.9.9-host',
    });

    const base = `http://127.0.0.1:${server.port}`;
    const meta = await authedFetch(server, base, '/api/v1/meta');
    const metaBody = await meta.json() as {
      code: number;
      data: { server_version: string };
    };
    expect(metaBody.data.server_version).toBe('9.9.9-host');

    const [instance] = await listLiveServerInstances(home);
    expect(instance?.serverVersion).toBe('9.9.9-host');

    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/9.9.9-host');
    expect(server.core.accessor.get(IBootstrapService).clientIdentity).toEqual({
      productName: 'test-host',
      version: '9.9.9-host',
      platform: 'test_platform',
    });
  });

  it('seeds default Kimi identity headers from hostIdentity that opts.seeds can override', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ua-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/0.0.0-test');
    expect(defaults.headers['X-Msh-Version']).toBe('0.0.0-test');
    expect(defaults.headers['X-Msh-Platform']).toBe('test_platform');

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IHostRequestHeaders, { headers: { 'User-Agent': 'custom-host/9.9' } }]],
    });
    const overridden = server.core.accessor.get(IHostRequestHeaders);
    expect(overridden.headers['User-Agent']).toBe('custom-host/9.9');
  });

  it('rejects invalid idle reclaim config before registering an instance', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-idle-reclaim-'));
    await expect(
      startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        env: { KIMI_CODE_SESSION_IDLE_RECLAIM_MS: 'nope' },
      }),
    ).rejects.toThrow(/KIMI_CODE_SESSION_IDLE_RECLAIM_MS.*non-negative integer/);
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it('seeds explicit skill dirs into the core scope when skillDirs is provided', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      skillDirs: ['/skills/explicit'],
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toEqual([
      '/skills/explicit',
    ]);

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toBeUndefined();
  });

  it('does not shut down a host-injected telemetry service when server telemetry is disabled', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-host-telemetry-'));
    await writeFile(join(home, 'config.toml'), 'telemetry = false\n', 'utf8');
    const shutdown = vi.fn(async () => {});

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ITelemetryService, { ...noopTelemetryService, shutdown }]],
    });

    await server.close();
    server = undefined;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('completes server cleanup when owned telemetry shutdown fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-telemetry-failure-'));
    const storage = new InMemoryStorageService();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (scope === 'telemetry') throw new Error('telemetry storage unavailable');
      await write(scope, key, data, options);
    });
    const auth = {
      _serviceBrand: undefined,
      getCachedAccessToken: async () => {
        throw new Error('telemetry auth unavailable');
      },
    } as unknown as IOAuthToolkit;

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      telemetry: true,
      seeds: [
        [IFileSystemStorageService, storage],
        [IOAuthToolkit, auth],
      ],
    });
    const core = server.core;
    core.accessor.get(ITelemetryService).track2('session_ended', { reason: 'exit' });

    await server.close();
    server = undefined;

    expect(() => core.accessor.get(IBootstrapService)).toThrow();
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it.each(['successful', 'persistently failing'] as const)(
    'waits for unowned session-index recovery before close allows home removal with %s storage',
    async (outcome) => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-recovery-close-'));
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const logs = server.core.accessor.get(IAppendLogStore);
      const storage = server.core.accessor.get(IFileSystemStorageService);
      const append = storage.append.bind(storage);
      const diskFull = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'disk full');
      let markRecoveryStarted!: () => void;
      const recoveryStarted = new Promise<void>((resolve) => {
        markRecoveryStarted = resolve;
      });
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let markDrainStarted!: () => void;
      const drainStarted = new Promise<void>((resolve) => {
        markDrainStarted = resolve;
      });
      const persistentlyFailing = outcome === 'persistently failing';
      let attempts = 0;
      let recoveryAppend: Promise<void> | undefined;
      const appendSpy = vi.spyOn(storage, 'append').mockImplementation(async (scope, key, data, options) => {
        if (scope === '' && key === 'session_index.jsonl') {
          attempts++;
          if (attempts === 1) {
            await append(scope, key, data.subarray(0, 5), options);
            throw diskFull;
          }
          if (attempts === 2) {
            markRecoveryStarted();
            recoveryAppend = recoveryGate.then(async () => {
              if (persistentlyFailing) throw diskFull;
              await append(scope, key, data, options);
            });
            await recoveryAppend;
            return;
          }
          if (persistentlyFailing) throw diskFull;
        }
        await append(scope, key, data, options);
      });
      const drainRetirements = logs.drainRetirements.bind(logs);
      const drainSpy = vi.spyOn(logs, 'drainRetirements').mockImplementation(() => {
        markDrainStarted();
        return drainRetirements();
      });
      let closing: Promise<void> | undefined;
      let closed = false;

      try {
        logs.append('', 'session_index.jsonl', { sessionId: 'example-session', deleted: true });
        await expect(logs.flushLog('', 'session_index.jsonl')).rejects.toBe(diskFull);
        await recoveryStarted;
        closing = server.close().then(() => {
          closed = true;
        });
        await drainStarted;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(closed).toBe(false);

        releaseRecovery();
        await closing;
        server = undefined;
        const record = '{"sessionId":"example-session","deleted":true}\n';
        expect(await readFile(join(home, 'session_index.jsonl'), 'utf8')).toBe(
          persistentlyFailing ? record.slice(0, 5) : record,
        );
        const expectedAttempts = persistentlyFailing ? 3 : 2;
        expect(attempts).toBe(expectedAttempts);
        await rm(home, { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        await expect(stat(home)).rejects.toHaveProperty('code', 'ENOENT');
        expect(attempts).toBe(expectedAttempts);
      } finally {
        releaseRecovery();
        await closing;
        await recoveryAppend?.catch(() => undefined);
        if (closed) server = undefined;
        appendSpy.mockRestore();
        drainSpy.mockRestore();
      }
    },
  );

  it.each([false, true])('drains an accepted wire dehydrator before close allows home removal when an earlier agent fails: %s', async (stopFails) => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-dehydrate-close-'));
    const logger = pino({ level: 'silent' });
    const warning = vi.spyOn(logger, 'warn');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      logger,
    });
    const session = await server.core.accessor.get(ISessionManager).create({ workDir: home });
    const agents = session.accessor.get(IAgentLifecycleService);
    await agents.create({ agentId: 'main' });
    if (stopFails) {
      await agents.create({ agentId: 'aux' });
      vi.spyOn(agents.handleOf('main')!.accessor.get(IAgentTaskService), 'stopAllOnExit')
        .mockRejectedValue(new Error('stop failed'));
    }
    const wire = agents.handleOf(stopFails ? 'aux' : 'main')!.accessor.get(IWireService);
    const removed = vi.spyOn(agents, 'remove');
    const hooks = vi.spyOn(server.core.accessor.get(IExternalHooksRunnerService), 'trigger');
    const sessionClosed = vi.fn();
    server.core.accessor.get(ISessionManager).onDidCloseSession!(sessionClosed);
    const telemetryEvents: string[] = [];
    const telemetry = server.core.accessor.get(ITelemetryService);
    telemetry.setEnabled(true);
    telemetry.addAppender({ track: (record) => { telemetryEvents.push(record.event); } });
    await server.core.accessor.get(IAppendLogStore).flush();
    const path = wire.journalPath()!;
    const baseline = await readFile(path);
    const storage = server.core.accessor.get(IFileSystemStorageService);
    const appendSpy = vi.spyOn(storage, 'append');
    const writeSpy = vi.spyOn(storage, 'write');
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    let markDehydrationStarted!: () => void;
    const dehydrationStarted = new Promise<void>((resolve) => {
      markDehydrationStarted = resolve;
    });
    let releaseDehydration!: () => void;
    const dehydrationGate = new Promise<void>((resolve) => {
      releaseDehydration = resolve;
    });
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      const record = { type: 'wire.test.dehydrated', time: 1 };
      wire.appendRecord(record, async (accepted) => {
        markDehydrationStarted();
        await dehydrationGate;
        return accepted;
      });
      await dehydrationStarted;
      closing = server.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect.soft(closed).toBe(false);

      releaseDehydration();
      await wire.drainPersisted();
      await closing;
      server = undefined;
      expect.soft(unexpected).toEqual([]);
      expect.soft(await readFile(path)).toEqual(Buffer.concat([
        baseline,
        Buffer.from(JSON.stringify(record) + '\n'),
      ]));
      expect(removed.mock.calls.map(([agent]) => agent.agentId)).toEqual(stopFails ? ['main', 'aux'] : ['main']);
      expect(hooks.mock.calls.filter(([event]) => event === 'SessionEnd')).toEqual([]);
      expect(sessionClosed).not.toHaveBeenCalled();
      expect(telemetryEvents).not.toContain('session_ended');
      if (stopFails) {
        expect(warning).toHaveBeenCalledWith(
          { err: expect.objectContaining({ message: 'stop failed' }), sessionId: session.id, agentId: 'main' },
          'agent removal failed; continuing shutdown',
        );
      }
      const appendsAtClose = appendSpy.mock.calls.length;
      const writesAtClose = writeSpy.mock.calls.length;
      await rm(home, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await expect(stat(home)).rejects.toHaveProperty('code', 'ENOENT');
      expect(appendSpy).toHaveBeenCalledTimes(appendsAtClose);
      expect(writeSpy).toHaveBeenCalledTimes(writesAtClose);
      expect(unexpected).toEqual([]);
    } finally {
      releaseDehydration();
      await closing;
      await wire.drainPersisted();
      if (closed) server = undefined;
      resetUnexpectedErrorHandler();
      appendSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('waits for a session close already draining accepted wire dehydration before shutdown', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-session-close-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const manager = server.core.accessor.get(ISessionManager);
    const session = await manager.create({ workDir: home });
    const agents = session.accessor.get(IAgentLifecycleService);
    await agents.create({ agentId: 'main' });
    const wire = agents.handleOf('main')!.accessor.get(IWireService);
    await wire.flush();
    const path = wire.journalPath()!;
    const baseline = await readFile(path);
    const storage = server.core.accessor.get(IFileSystemStorageService);
    const append = vi.spyOn(storage, 'append');
    const write = vi.spyOn(storage, 'write');
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => { unexpected.push(error); });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const dehydrating = new Promise<void>((resolve) => { started = resolve; });
    let flushing!: () => void;
    const draining = new Promise<void>((resolve) => { flushing = resolve; });
    const flush = wire.flush.bind(wire);
    vi.spyOn(wire, 'flush').mockImplementation(() => { flushing(); return flush(); });
    let sessionClosing: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      const record = { type: 'wire.test.concurrent-close', time: 1 };
      wire.appendRecord(record, async (accepted) => {
        started();
        await gate;
        return accepted;
      });
      await dehydrating;
      sessionClosing = manager.close(session.id);
      void sessionClosing.catch(() => {});
      await draining;
      expect(agents.list()).toEqual([]);
      closing = server.close().then(() => { closed = true; });
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect(closed).toBe(false);

      release();
      await sessionClosing;
      await closing;
      server = undefined;
      const bytes = Buffer.concat([baseline, Buffer.from(JSON.stringify(record) + '\n')]);
      expect(await readFile(path)).toEqual(bytes);
      expect(unexpected).toEqual([]);
      const appendsAtClose = append.mock.calls.length;
      const writesAtClose = write.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(append).toHaveBeenCalledTimes(appendsAtClose);
      expect(write).toHaveBeenCalledTimes(writesAtClose);
      expect(await readFile(path)).toEqual(bytes);
      expect(unexpected).toEqual([]);
    } finally {
      release();
      await closing;
      await Promise.race([
        sessionClosing?.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      if (closed) server = undefined;
      resetUnexpectedErrorHandler();
      append.mockRestore();
      write.mockRestore();
    }
  });

  it('settles session metadata before draining the session-index mirror on shutdown', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-metadata-close-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const session = await server.core.accessor.get(ISessionManager).create({ workDir: home });
    const context = session.accessor.get(ISessionContext);
    const documents = server.core.accessor.get(IAtomicDocumentStore);
    const set = documents.set.bind(documents);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const write = vi.spyOn(documents, 'set').mockImplementation(async (scope, key, value) => {
      if (scope === context.metaScope && key === 'state.json') {
        started();
        await gate;
      }
      await set(scope, key, value);
    });
    const mirror = server.core.accessor.get(ISessionIndexMirror);
    const drain = vi.spyOn(mirror, 'drain');
    const record = vi.spyOn(mirror, 'record');
    const updating = session.accessor.get(ISessionMetadata).setTitle('Metadata before shutdown');
    await writing;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    try {
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect.soft(closed).toBe(false);
      expect.soft(drain).not.toHaveBeenCalled();
    } finally {
      release();
      await updating;
      await closing;
      server = undefined;
      write.mockRestore();
    }
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ title: 'Metadata before shutdown' }));
    expect(drain).toHaveBeenCalled();
  });

  it.each(['shutdown', 'automatic'] as const)(
    'finishes partial wire recovery before releasing session locks on shutdown: %s',
    async (schedule) => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-wire-lock-close-'));
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const session = await server.core.accessor.get(ISessionManager).create({ workDir: home });
      const agents = session.accessor.get(IAgentLifecycleService);
      await agents.create({ agentId: 'main' });
      const wire = agents.handleOf('main')!.accessor.get(IWireService);
      await server.core.accessor.get(IAppendLogStore).flush();
      const path = wire.journalPath()!;
      const baseline = await readFile(path);
      const storage = server.core.accessor.get(IFileSystemStorageService);
      const locks = server.core.accessor.get(ISessionLockService) as SessionLockService;
      const contender = new SessionLockService(
        server.core.accessor.get(IBootstrapService),
        server.core.accessor.get(ILogService),
      );
      const append = storage.append.bind(storage);
      const disposeLock = locks.dispose.bind(locks);
      const tryHold = locks.tryHold.bind(locks);
      const lease = locks.lease.bind(locks);
      let lockDisposed = false;
      let callsAfterDispose = 0;
      const disposeSpy = vi.spyOn(locks, 'dispose').mockImplementation(() => {
        lockDisposed = true;
        disposeLock();
      });
      const holdSpy = vi.spyOn(locks, 'tryHold').mockImplementation((sessionId) => {
        if (lockDisposed) callsAfterDispose++;
        return tryHold(sessionId);
      });
      const leaseSpy = vi.spyOn(locks, 'lease').mockImplementation((sessionId) => {
        if (lockDisposed) callsAfterDispose++;
        return lease(sessionId);
      });
      const diskFull = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'disk full');
      let markRecoveryStarted!: () => void;
      const recoveryStarted = new Promise<void>((resolve) => {
        markRecoveryStarted = resolve;
      });
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let attempts = 0;
      const appendSpy = vi.spyOn(storage, 'append').mockImplementation(async (scope, key, data, options) => {
        if (key === 'wire.jsonl') {
          attempts++;
          if (attempts === 1) {
            await append(scope, key, data.subarray(0, 7), options);
            throw diskFull;
          }
          if (attempts === 2) {
            markRecoveryStarted();
            await recoveryGate;
          }
        }
        await append(scope, key, data, options);
      });
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        const first = { type: 'wire.test.shutdown', text: '中文', time: 1 };
        const second = { type: 'wire.test.after.failure', time: 2 };
        wire.appendRecord(first);
        await expect(wire.flush()).rejects.toBe(diskFull);
        wire.appendRecord(second);
        expect(locks.held(session.id)).toBe(true);
        if (schedule === 'automatic') await recoveryStarted;
        closing = server.close().then(() => {
          closed = true;
        });
        if (schedule === 'shutdown') await recoveryStarted;
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(closed).toBe(false);
        const contenderAcquired = contender.tryHold(session.id);
        expect.soft(locks.held(session.id)).toBe(true);
        expect.soft(contenderAcquired).toBe(false);
        if (contenderAcquired) contender.release(session.id);
        releaseRecovery();
        await closing;
        server = undefined;

        expect(await readFile(path)).toEqual(Buffer.concat([
          baseline,
          Buffer.from([first, second].map((record) => JSON.stringify(record) + '\n').join('')),
        ]));
        expect(lockDisposed).toBe(true);
        expect(callsAfterDispose).toBe(0);
        expect(locks.held(session.id)).toBe(false);
        expect(await readdir(join(home, 'locks', 'sessions'))).toEqual([]);
      } finally {
        releaseRecovery();
        await closing;
        if (closed) server = undefined;
        contender.dispose();
        appendSpy.mockRestore();
        holdSpy.mockRestore();
        leaseSpy.mockRestore();
        disposeSpy.mockRestore();
      }
    },
  );

  it('logs process-level exceptions without exiting and removes the handlers on close', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const rejectionBefore = process.listeners('unhandledRejection');
    const exceptionBefore = process.listeners('uncaughtException');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logger: pino({ level: 'error' }, stream),
    });

    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore.length + 1);
    expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore.length + 1);

    const onUncaughtException = process
      .listeners('uncaughtException')
      .find((listener) => !exceptionBefore.includes(listener)) as
      | ((error: Error) => void)
      | undefined;
    const onUnhandledRejection = process
      .listeners('unhandledRejection')
      .find((listener) => !rejectionBefore.includes(listener)) as
      | ((reason: unknown) => void)
      | undefined;
    expect(onUncaughtException).toBeDefined();
    expect(onUnhandledRejection).toBeDefined();

    onUncaughtException?.(new Error('synthetic uncaught'));
    onUnhandledRejection?.(new Error('synthetic rejection'));

    const output = lines.join('');
    expect(output).toContain('"msg":"uncaughtException"');
    expect(output).toContain('"msg":"unhandledRejection"');

    const healthz = await fetch(`http://127.0.0.1:${server.port}/api/v1/healthz`);
    expect(healthz.status).toBe(200);

    await server.close();
    server = undefined;

    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore.length);
    expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore.length);
  });

  it('does not leave process handlers installed when startup fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    const emptyAssets = await mkdtemp(join(tmpdir(), 'kimi-server-v2-assets-'));
    const rejectionBefore = process.listenerCount('unhandledRejection');
    const exceptionBefore = process.listenerCount('uncaughtException');
    try {
      await expect(
        startServer({
          hostIdentity: TEST_HOST_IDENTITY,
          host: '127.0.0.1',
          port: 0,
          homeDir: home,
          logLevel: 'silent',
          webAssetsDir: emptyAssets,
        }),
      ).rejects.toThrow('web assets');
      expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore);
      expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore);
    } finally {
      await rm(emptyAssets, { recursive: true, force: true });
    }
  });
});

function silentLogger() {
  return pino({ level: 'silent' });
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  err.code = 'EADDRINUSE';
  return err;
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

describe('listenWithPortRetry', () => {
  it('returns the requested port when the first listen succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5000);
    expect(attempts).toEqual([5000]);
  });

  it('retries with port+1 on EADDRINUSE until a bind succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        if (port < 5002) throw addrInUse();
        return `http://127.0.0.1:${String(port)}`;
      },
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
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw boom;
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
      }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([5000]);
  });

  it('throws after exhausting maxRetries', async () => {
    const attempts: number[] = [];
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw addrInUse();
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(attempts).toEqual([5000, 5001, 5002, 5003]);
  });

  it('does not walk ports when the requested port is 0 (ephemeral)', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return 'http://127.0.0.1:54321';
      },
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
    });

    expect(result.port).toBe(0);
    expect(attempts).toEqual([0]);
  });
});

describe('server-v2 boot — port retry', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('retries on port+1 and advertises the bound port in the instance registry', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-port-retry-'));
    const { port, next } = await allocateAdjacentFreePair();
    const occupant = await listenOnPort('127.0.0.1', port);
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port,
        homeDir: home,
        logLevel: 'silent',
      });

      expect(server.port).toBeGreaterThanOrEqual(next);
      const [instance] = await listLiveServerInstances(home);
      expect(instance?.port).toBe(server.port);
    } finally {
      await closeNetServer(occupant);
    }
  });
});
