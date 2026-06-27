import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { HostFileSystem, IHostFileSystem } from '#/hostFs';
import { ISessionStore } from '#/sessionStore/sessionStore';
import { SessionStore, encodeWorkDirKey } from '#/sessionStore/sessionStoreService';

describe('encodeWorkDirKey', () => {
  it('is deterministic and path-sensitive', () => {
    const a = encodeWorkDirKey('/home/user/repo');
    const b = encodeWorkDirKey('/home/user/repo');
    const c = encodeWorkDirKey('/home/user/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('wd_')).toBe(true);
  });
});

describe('SessionStore workspace helpers', () => {
  let sessionsRoot: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Core, ISessionStore, SessionStore, InstantiationType.Delayed, 'records');
    sessionsRoot = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(sessionsRoot, { recursive: true, force: true });
  });

  function build(): ISessionStore {
    const host = createScopedTestHost([stubPair(IHostFileSystem, new HostFileSystem())]);
    disposeHost = () => host.dispose();
    return host.core.accessor.get(ISessionStore);
  }

  it('workspaceIdFor matches encodeWorkDirKey', () => {
    const store = build();
    const workDir = '/home/user/repo';
    expect(store.workspaceIdFor(workDir)).toBe(encodeWorkDirKey(workDir));
  });

  it('countActiveSessions counts non-archived session dirs', async () => {
    const store = build();
    const workDir = '/home/user/repo';
    const wsDir = join(sessionsRoot, encodeWorkDirKey(workDir));

    await fsp.mkdir(join(wsDir, 'active'), { recursive: true });
    await fsp.writeFile(join(wsDir, 'active', 'state.json'), '{}');

    await fsp.mkdir(join(wsDir, 'archived'), { recursive: true });
    await fsp.writeFile(join(wsDir, 'archived', 'state.json'), JSON.stringify({ archived: true }));

    await fsp.mkdir(join(wsDir, 'no-state'), { recursive: true });

    expect(await store.countActiveSessions(sessionsRoot, workDir)).toBe(2);
  });

  it('countActiveSessions returns 0 when the work dir has no sessions yet', async () => {
    const store = build();
    expect(await store.countActiveSessions(sessionsRoot, '/home/user/never-created')).toBe(0);
  });
});
