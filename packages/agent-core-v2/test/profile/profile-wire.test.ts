import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentProfileService, IAgentProfileService } from '#/agent/profile';
import { ProfileModel } from '#/agent/profile/profileOps';
import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { IModelResolver } from '#/app/model';
import { ITelemetryService } from '#/app/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IExecContext } from '#/session/execContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import { IAgentWireService, WireService, type IWireService, type PersistedRecord } from '#/wire';

const SCOPE = 'wire';
const KEY = 'profile-test';

function createTelemetryStub(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: () => undefined,
  } as unknown as ITelemetryService;
}

function createConfigStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;
}

function createModelResolverStub(): IModelResolver {
  return {
    _serviceBrand: undefined,
    resolve: () => {
      throw new Error('not exercised');
    },
  } as unknown as IModelResolver;
}

function stubUnused<T>(): T {
  return { _serviceBrand: undefined } as unknown as T;
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let wire: IWireService;
let svc: IAgentProfileService;

function buildHost(key: string): {
  ix: TestInstantiationService;
  wire: IWireService;
  svc: IAgentProfileService;
  log: IAppendLogStore;
} {
  const host = disposables.add(new TestInstantiationService());
  host.stub(IFileSystemStorageService, new InMemoryStorageService());
  host.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  host.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: key }]));
  host.stub(ITelemetryService, createTelemetryStub());
  host.stub(IConfigService, createConfigStub());
  host.stub(IModelResolver, createModelResolverStub());
  host.stub(IHostEnvironment, stubUnused());
  host.stub(IHostFileSystem, stubUnused());
  host.stub(IExecContext, stubUnused());
  host.stub(IBootstrapService, stubUnused());
  host.stub(ISessionWorkspaceContext, stubUnused());
  host.stub(IAgentProfileCatalogService, stubUnused());
  host.stub(ISessionSkillCatalog, stubUnused());
  host.set(IAgentProfileService, new SyncDescriptor(AgentProfileService));
  return {
    ix: host,
    wire: host.get(IAgentWireService),
    svc: host.get(IAgentProfileService),
    log: host.get(IAppendLogStore),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  ix = host.ix;
  wire = host.wire;
  svc = host.svc;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IWireService) {
  return target.getModel(ProfileModel);
}

describe('AgentProfileService (wire-backed config.update)', () => {
  it('update persists a flat config.update record and resolves thinkingLevel at the call site', async () => {
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: 'You are helpful.' });
    svc.update({ thinkingLevel: 'on' });

    const model = modelOf(wire);
    expect(model.profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(model.systemPrompt).toBe('You are helpful.');
    // 'on' resolves against the default effort (no thinking config section) → 'high'.
    expect(model.thinkingLevel).toBe('high');
    expect(svc.getSystemPrompt()).toBe('You are helpful.');

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'config.update',
        profileName: DEFAULT_AGENT_PROFILE_NAME,
        systemPrompt: 'You are helpful.',
        time: expect.any(Number),
      },
      { type: 'config.update', thinkingLevel: 'high', time: expect.any(Number) },
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('re-dispatching an equal config is a no-op on the model (same reference)', () => {
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME });
    const before = modelOf(wire);
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME });
    expect(modelOf(wire)).toBe(before);
  });

  it('chdir and emitStatusUpdated run live-only and are silent during replay', async () => {
    let chdirCalls = 0;
    let statusEmits = 0;
    svc.configure({
      chdir: () => {
        chdirCalls += 1;
      },
      emitStatusUpdated: () => {
        statusEmits += 1;
      },
    });

    svc.update({ cwd: '/work', profileName: DEFAULT_AGENT_PROFILE_NAME });
    expect(chdirCalls).toBe(1);
    expect(statusEmits).toBe(1);

    const records = await readRecords();

    // Fresh host + wire: replay the persisted records. The Model rebuilds but
    // neither chdir nor emitStatusUpdated re-fires — replay is silent.
    const host = buildHost('profile-replay');
    let replayChdir = 0;
    let replayEmits = 0;
    host.svc.configure({
      chdir: () => {
        replayChdir += 1;
      },
      emitStatusUpdated: () => {
        replayEmits += 1;
      },
    });

    host.wire.replay(...records);
    expect(modelOf(host.wire).cwd).toBe('/work');
    expect(modelOf(host.wire).profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(replayChdir).toBe(0);
    expect(replayEmits).toBe(0);

    const written: PersistedRecord[] = [];
    for await (const record of host.log.read<PersistedRecord>(SCOPE, 'profile-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });

  it('replay rebuilds the resolved thinkingLevel without re-reading config', async () => {
    svc.update({ thinkingLevel: 'on' });
    const records = await readRecords();

    // Fresh host whose config section would resolve differently is irrelevant:
    // the persisted resolved value ('high') is restored verbatim.
    const host = buildHost('profile-replay-thinking');
    host.wire.replay(...records);
    expect(modelOf(host.wire).thinkingLevel).toBe('high');
  });
});
