import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentContextInjectorService,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { PermissionModeInjection } from '#/agent/permissionMode/injection/permissionModeInjection';
import { AgentPermissionModeService } from '#/agent/permissionMode/permissionModeService';
import { PermissionModeModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'permission-mode-test';

let registeredInjection:
  | {
      readonly name: string;
      readonly provider: ContextInjectionProvider;
    }
  | undefined;

const injectorStub: IAgentContextInjectorService = {
  _serviceBrand: undefined,
  register: (name, provider) => {
    registeredInjection = { name, provider };
    return {
      dispose: () => {
        if (registeredInjection?.provider === provider) registeredInjection = undefined;
      },
    };
  },
  injectAfterCompaction: async () => {},
};

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentPermissionModeService;
let reminderLive = false;

beforeEach(() => {
  registeredInjection = undefined;
  reminderLive = false;
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.stub(IAgentContextInjectorService, injectorStub);
  ix.set(IAgentPermissionModeService, new SyncDescriptor(AgentPermissionModeService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  svc = ix.get(IAgentPermissionModeService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await ix.get(IWireService).flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

async function runRegisteredInjection(): Promise<string | undefined> {
  const provider = registeredInjection?.provider;
  if (provider === undefined) throw new Error('expected permission mode injection provider');
  const content = await provider({
    injectedPositions: reminderLive ? [0] : [],
    lastInjectedAt: reminderLive ? 0 : null,
    isNewTurn: true,
  });
  if (typeof content !== 'string' && content !== undefined) {
    throw new Error('expected permission mode injection provider to return text');
  }
  if (content !== undefined) reminderLive = true;
  return content;
}

function spliceReminderOut(): void {
  reminderLive = false;
}

describe('AgentPermissionModeService (wire-backed)', () => {
  it('setMode updates mode and fires onDidChangeMode with mode/previousMode', () => {
    const changes: { mode: PermissionMode; previousMode: PermissionMode }[] = [];
    disposables.add(
      svc.onDidChangeMode((ctx) => {
        changes.push({ mode: ctx.mode, previousMode: ctx.previousMode });
      }),
    );

    expect(svc.mode).toBe('manual');

    svc.setMode('manual');
    expect(changes).toEqual([]);

    svc.setMode('auto');
    expect(svc.mode).toBe('auto');
    expect(changes).toEqual([{ mode: 'auto', previousMode: 'manual' }]);

    svc.setMode('auto');
    expect(changes).toEqual([{ mode: 'auto', previousMode: 'manual' }]);
  });

  it('dispatch persists a flat { type, mode } record (no payload key)', async () => {
    svc.setMode('auto');

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'permission.set_mode', mode: 'auto', time: expect.any(Number) },
    ]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('persists an explicitly configured manual mode when it matches the initial value', async () => {
    svc.setMode('manual');

    expect(await readRecords()).toEqual([
      { type: 'permission.set_mode', mode: 'manual', time: expect.any(Number) },
    ]);
  });

  it('registers auto-mode reminder injection through the injection service', async () => {
    expect(registeredInjection?.name).toBe('permission_mode');

    expect(await runRegisteredInjection()).toBeUndefined();

    svc.setMode('auto');
    const autoReminder = await runRegisteredInjection();
    expect(autoReminder).toContain('Auto permission mode is active');
    expect(autoReminder).toContain('ExitPlanMode is also approved automatically');
    expect(await runRegisteredInjection()).toBeUndefined();

    svc.setMode('manual');
    expect(await runRegisteredInjection()).toContain('Auto permission mode is no longer active');
  });

  it('re-announces auto mode after the live reminder is spliced out (compaction / undo)', async () => {
    svc.setMode('auto');
    expect(await runRegisteredInjection()).toContain('Auto permission mode is active');
    expect(await runRegisteredInjection()).toBeUndefined();

    spliceReminderOut();
    expect(await runRegisteredInjection()).toContain('Auto permission mode is active');
    expect(await runRegisteredInjection()).toBeUndefined();
  });

  it('announces nothing after compaction when the current mode carries no reminder', async () => {
    expect(await runRegisteredInjection()).toBeUndefined();

    spliceReminderOut();
    expect(await runRegisteredInjection()).toBeUndefined();
  });

  it('re-announces auto mode on a fresh instance even with a live reminder in history (restore)', async () => {
    svc.setMode('auto');

    let restoredProvider: ContextInjectionProvider | undefined;
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: (_name, provider) => {
        restoredProvider = provider;
        return { dispose: () => {} };
      },
      injectAfterCompaction: async () => {},
    });
    disposables.add(ix2.createInstance(PermissionModeInjection, svc));
    if (restoredProvider === undefined) throw new Error('expected restored provider');

    const run = () =>
      restoredProvider!({
        injectedPositions: [3],
        lastInjectedAt: 3,
        isNewTurn: true,
      });

    expect(await run()).toContain('Auto permission mode is active');
    expect(await run()).toBeUndefined();
    svc.setMode('manual');
    expect(await run()).toContain('Auto permission mode is no longer active');
  });

  it('replay rebuilds mode from a persisted record on a fresh WireService (silent)', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    const fresh = registerTestAgentWire(ix2, testWireScope(SCOPE, 'permission-mode-replay'), {
      log: log2,
    });

    await restoreTestAgentWire(
      fresh,
      log2,
      testWireScope(SCOPE, 'permission-mode-replay'),
      [{ type: 'permission.set_mode', mode: 'auto' }],
    );

    expect(fresh.getModel(PermissionModeModel)).toBe('auto');

    const written: WireRecord[] = [];
    for await (const record of log2.read<WireRecord>(testWireScope(SCOPE, 'permission-mode-replay'), AGENT_WIRE_RECORD_KEY)) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual([{ type: 'permission.set_mode', mode: 'auto' }]);
  });
});
