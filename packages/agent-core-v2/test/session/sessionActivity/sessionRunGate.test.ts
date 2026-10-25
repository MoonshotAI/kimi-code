import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  type ISessionActivityView,
  type SessionActivityChangedEvent,
  type SessionActivityState,
} from '#/session/sessionActivity/sessionActivity';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SessionLockService } from '#/persistence/backends/node-fs/sessionLockService';
import { SessionRunGateService } from '#/session/sessionActivity/sessionRunGateService';
import { noopLogger } from '../../wire/stubs';

const SID = 'session-1';
const SCOPE = 'sessions/ws1/session-1/agents/main';
const KEY = 'wire.jsonl';

const sessionContextStub = {
  sessionId: SID,
  scope: (subKey?: string) => `sessions/ws1/${SID}/${subKey}`,
} as ISessionContext;

function bootstrapStub(homeDir: string, platform = 'test_client'): IBootstrapService {
  return {
    homeDir,
    clientIdentity: { productName: 'test', version: '0.0.0', platform },
    getEnv: (_name: string): string | undefined => undefined,
  } as IBootstrapService;
}

function activityStub(disposables: DisposableStore) {
  const emitter = disposables.add(new Emitter<SessionActivityChangedEvent>());
  let state: SessionActivityState = {
    busy: true,
    mainTurnActive: true,
    pendingInteraction: 'none',
  };
  return {
    view: {
      _serviceBrand: undefined,
      state: () => state,
      onDidChange: emitter.event,
    } as ISessionActivityView,
    setBusy(busy: boolean): void {
      state = { ...state, busy, mainTurnActive: busy };
      emitter.fire({ state, cause: busy ? 'turn_started' : 'turn_ended' });
    },
  };
}

describe('SessionRunGateService', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let storage: FileStorageService;
  let log: IAppendLogStore;
  let serviceA: SessionLockService;
  let serviceB: SessionLockService;
  let activity: ReturnType<typeof activityStub>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'session-run-gate-'));
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    storage = new FileStorageService(homeDir);
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(ILogService, noopLogger);
    serviceA = new SessionLockService(bootstrapStub(homeDir, 'client_a'), noopLogger);
    serviceB = new SessionLockService(bootstrapStub(homeDir, 'client_b'), noopLogger);
    ix.stub(ISessionLockService, serviceA);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    activity = activityStub(disposables);
  });

  afterEach(async () => {
    disposables.dispose();
    await log.drainRetirements();
    serviceA.dispose();
    serviceB.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function agentsOf(...agentIds: string[]): IAgentLifecycleService {
    return {
      list: () => agentIds.map((agentId) => ({ agentId })),
      handleOf: (agentId: string) => ({
        accessor: {
          get: () => ({
            externallyModified: () =>
              log.externallyModified(sessionContextStub.scope(`agents/${agentId}`), KEY),
          }),
        },
      }),
    } as unknown as IAgentLifecycleService;
  }

  function gate(agents: IAgentLifecycleService = agentsOf('main')): SessionRunGateService {
    return disposables.add(
      new SessionRunGateService(sessionContextStub, serviceA, log, agents, activity.view),
    );
  }

  async function readAll(): Promise<void> {
    for await (const _ of log.read(SCOPE, KEY)) {
      void _;
    }
  }

  function writeExternally(text: string, scope = SCOPE): void {
    const filePath = join(homeDir, scope, KEY);
    mkdirSync(join(homeDir, scope), { recursive: true });
    appendFileSync(filePath, text);
  }

  it('acquires the lock on a fresh session', async () => {
    await readAll();
    expect(() => {
      gate().begin();
    }).not.toThrow();
    expect(serviceA.held(SID)).toBe(true);
    serviceA.release(SID);
  });

  it('throws session.stale and releases when the wire changed on disk', async () => {
    await readAll();
    writeExternally(`${JSON.stringify({ type: 'metadata', protocol_version: 1 })}\n`);
    let caught: unknown;
    try {
      gate().begin();
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.stale');
    expect(serviceA.held(SID)).toBe(false);
  });

  it('throws session.stale and releases when a loaded subagent wire changed on disk', async () => {
    const subScope = 'sessions/ws1/session-1/agents/coder-1';
    const withSubagent = agentsOf('main', 'coder-1');
    await readAll();
    for await (const _ of log.read(subScope, KEY)) {
      void _;
    }
    writeExternally(`${JSON.stringify({ type: 'metadata', protocol_version: 1 })}\n`, subScope);
    let caught: unknown;
    try {
      gate(withSubagent).begin();
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.stale');
    expect(serviceA.held(SID)).toBe(false);
  });

  it('checks staleness even when the lock was already acquired by another path', async () => {
    await readAll();
    serviceA.hold(SID);
    writeExternally(`${JSON.stringify({ type: 'metadata', protocol_version: 1 })}\n`);
    let caught: unknown;
    try {
      gate().begin();
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.stale');
    expect(serviceA.held(SID)).toBe(false);
  });

  it('passes after own appends are flushed', async () => {
    await readAll();
    gate().begin();
    log.append(SCOPE, KEY, { type: 'metadata', protocol_version: 1 });
    await log.flush();
    expect(() => {
      gate().begin();
    }).not.toThrow();
    serviceA.release(SID);
  });

  it('throws session.occupied when another client runs the session', async () => {
    await readAll();
    serviceB.hold(SID);
    let caught: unknown;
    try {
      gate().begin();
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.occupied');
    serviceB.release(SID);
  });

  it('releases a directly held lock only after the session becomes idle', async () => {
    vi.useFakeTimers();
    try {
      gate();
      serviceA.hold(SID);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(serviceA.held(SID)).toBe(true);
      activity.setBusy(false);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(serviceA.held(SID)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(serviceA.held(SID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'checks for external writes before recovering a failed boundary stat after an idle lock handoff: %s',
    async (writeExternally) => {
      vi.useFakeTimers();
      const originalSize = storage.size.bind(storage);
      const originalAppend = storage.append.bind(storage);
      const initial = { type: 'wire.test.initial' };
      const deferredRecord = { type: 'wire.test.client_a' };
      const externalRecord = { type: 'wire.test.client_b' };
      const encode = (record: unknown): Uint8Array =>
        new TextEncoder().encode(`${JSON.stringify(record)}\n`);
      const failure = new StorageError(
        StorageErrors.codes.STORAGE_IO_FAILED,
        'transient boundary stat failure',
      );
      let unavailable = true;
      const release = serviceA.release.bind(serviceA);
      let markHandoff!: () => void;
      const handedOff = new Promise<void>((resolve) => {
        markHandoff = resolve;
      });
      let transferred = false;
      const releaseSpy = vi.spyOn(serviceA, 'release').mockImplementation((sessionId) => {
        release(sessionId);
        if (sessionId === SID && !transferred && !serviceA.held(SID)) {
          serviceB.hold(SID);
          transferred = true;
          markHandoff();
        }
      });
      try {
        await originalAppend(SCOPE, KEY, encode(initial));
        await readAll();
        const runGate = gate();
        disposables.add(log.bindWriteGuard(SCOPE, KEY, () => serviceA.tryHold(SID)));
        runGate.begin();
        expect(serviceA.held(SID)).toBe(true);

        storage.size = async (...args) => {
          if (unavailable) throw failure;
          return originalSize(...args);
        };
        let reportFailure!: (error: unknown) => void;
        const reported = new Promise<unknown>((resolve) => {
          reportFailure = resolve;
        });
        const recovered = vi.fn();
        disposables.add(log.onDidRecover(recovered));
        log.append(SCOPE, KEY, deferredRecord, { onError: reportFailure });
        expect(await reported).toBe(failure);
        activity.setBusy(false);
        await vi.advanceTimersByTimeAsync(3_000);
        await handedOff;
        expect(serviceA.held(SID)).toBe(false);

        expect(serviceB.held(SID)).toBe(true);
        if (writeExternally) await originalAppend(SCOPE, KEY, encode(externalRecord));
        serviceB.release(SID);
        expect(log.externallyModified(SCOPE, KEY)).toBe(writeExternally);
        unavailable = false;
        await vi.advanceTimersByTimeAsync(60_000);
        const recoveryFailure: unknown = await log.flush().then(
          () => undefined,
          (error: unknown) => error,
        );

        if (writeExternally) {
          expect.soft(recoveryFailure).toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
          expect.soft(recovered).not.toHaveBeenCalled();
          expect.soft(log.externallyModified(SCOPE, KEY)).toBe(true);
          expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
            `${JSON.stringify(initial)}\n${JSON.stringify(externalRecord)}\n`,
          );
        } else {
          expect(recoveryFailure).toBeUndefined();
          expect(recovered).toHaveBeenCalledOnce();
          expect(log.externallyModified(SCOPE, KEY)).toBe(false);
          expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
            `${JSON.stringify(initial)}\n${JSON.stringify(deferredRecord)}\n`,
          );
        }
      } finally {
        releaseSpy.mockRestore();
        storage.size = originalSize;
        vi.useRealTimers();
      }
    },
  );
});
