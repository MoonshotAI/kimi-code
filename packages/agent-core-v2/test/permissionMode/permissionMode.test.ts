import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { AgentPermissionModeService, IAgentPermissionModeService } from '#/agent/permissionMode';
import { PermissionModeModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService, WireService, type PersistedRecord } from '#/wire';

const SCOPE = 'wire';
const KEY = 'permission-mode-test';

const injectorStub: IAgentContextInjectorService = {
  _serviceBrand: undefined,
  register: () => ({ dispose: () => {} }),
};

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentPermissionModeService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  ix.stub(IAgentContextInjectorService, injectorStub);
  ix.set(IAgentPermissionModeService, new SyncDescriptor(AgentPermissionModeService));
  log = ix.get(IAppendLogStore);
  svc = ix.get(IAgentPermissionModeService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, KEY)) {
    out.push(record);
  }
  return out;
}

describe('AgentPermissionModeService (wire-backed)', () => {
  it('setMode updates mode and fires onChanged with mode/previousMode', () => {
    const changes: { mode: PermissionMode; previousMode: PermissionMode }[] = [];
    svc.hooks.onChanged.register('test', (ctx, next) => {
      changes.push({ mode: ctx.mode, previousMode: ctx.previousMode });
      return next();
    });

    expect(svc.mode).toBe('manual');

    svc.setMode('auto');
    expect(svc.mode).toBe('auto');
    expect(changes).toEqual([{ mode: 'auto', previousMode: 'manual' }]);

    // Re-dispatching the current mode is a no-op: apply returns the same
    // reference, so the wire emits no change and onChanged does not fire again.
    svc.setMode('auto');
    expect(changes).toEqual([{ mode: 'auto', previousMode: 'manual' }]);
  });

  it('dispatch persists a flat { type, mode } record (no payload key)', async () => {
    svc.setMode('auto');

    const records = await readRecords();
    expect(records).toEqual([{ type: 'permission.set_mode', mode: 'auto' }]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('replay rebuilds mode from a persisted record on a fresh WireService (silent)', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'permission-mode-replay' }]),
    );
    const log2 = ix2.get(IAppendLogStore);
    const fresh = ix2.get(IAgentWireService);

    fresh.replay({ type: 'permission.set_mode', mode: 'auto' });

    expect(fresh.getModel(PermissionModeModel)).toBe('auto');

    // Replay is silent: nothing is written back to the wire log.
    const written: PersistedRecord[] = [];
    for await (const record of log2.read<PersistedRecord>(SCOPE, 'permission-mode-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });
});
