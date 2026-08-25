import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentCacheProbeService } from '#/agent/usage/cacheProbeService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AgentUsage } from '#/features/usage/usageAgentRuntime';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { SessionUsageService } from '#/session/usage/sessionUsageService';

import {
  attachUsageRuntime,
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'usage-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let svc: ISessionUsageService;
let agent: AgentContext;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  const dispatcher = registerTestEventDispatcher(ix);
  const runtimes = attachUsageRuntime(ix, dispatcher);
  ix.stub(IAgentLifecycleService, {
    resolve: (_agent: unknown, definition: unknown) => {
      if (definition !== AgentUsage) throw new Error('unexpected resolve');
      return runtimes.resolve(AgentUsage);
    },
  } as unknown as IAgentLifecycleService);
  ix.set(ISessionUsageService, new SyncDescriptor(SessionUsageService));
  svc = ix.get(ISessionUsageService);
  agent = ix.get(IAgentScopeContext).agentContext;
});

afterEach(() => disposables.dispose());

const a1 = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
const a2 = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
const b1 = { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 };

describe('AgentCacheProbeService', () => {
  function stubProbeDeps(forkedFrom: string | undefined): ReturnType<typeof vi.fn> {
    const track2 = vi.fn();
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2,
    } as unknown as ITelemetryService);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (alias: string) => {
        if (alias !== 'model-a') throw new Error(`unknown model "${alias}"`);
        return { id: alias, protocol: 'anthropic', providerType: 'kimi' } as unknown as Model;
      },
    } as unknown as IModelCatalog);
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'test-agent', agentScope: '', forkedFrom }),
    );
    return track2;
  }

  it('probes the first turn request of a forked agent', async () => {
    const track2 = stubProbeDeps('main');
    disposables.add(ix.createInstance(AgentCacheProbeService));

    await svc.record(agent, 'model-a', a1, { type: 'turn', turnId: 1 });

    expect(track2).toHaveBeenCalledTimes(1);
    expect(track2).toHaveBeenCalledWith('prompt_cache_probe', {
      source: 'fork',
      turn_id: 1,
      provider_type: 'kimi',
      protocol: 'anthropic',
      input_tokens: 8,
      input_cache_read: 3,
      input_cache_creation: 4,
      output_tokens: 2,
    });
  });

  it('probes only once', async () => {
    const track2 = stubProbeDeps('main');
    disposables.add(ix.createInstance(AgentCacheProbeService));

    await svc.record(agent, 'model-a', a1, { type: 'turn', turnId: 1 });
    await svc.record(agent, 'model-a', a2, { type: 'turn', turnId: 2 });

    expect(track2).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a non-forked agent', async () => {
    const track2 = stubProbeDeps(undefined);
    disposables.add(ix.createInstance(AgentCacheProbeService));

    await svc.record(agent, 'model-a', a1, { type: 'turn', turnId: 1 });

    expect(track2).not.toHaveBeenCalled();
  });

  it('stays silent when the first record is not a turn request', async () => {
    const track2 = stubProbeDeps('main');
    disposables.add(ix.createInstance(AgentCacheProbeService));

    await svc.record(agent, 'model-a', a1);
    await svc.record(agent, 'model-a', a2, { type: 'turn', turnId: 1 });

    expect(track2).not.toHaveBeenCalled();
  });

  it('probes without provider fields when the model alias is unknown', async () => {
    const track2 = stubProbeDeps('main');
    disposables.add(ix.createInstance(AgentCacheProbeService));

    await svc.record(agent, 'model-b', b1, { type: 'turn', turnId: 1 });

    expect(track2).toHaveBeenCalledWith('prompt_cache_probe', {
      source: 'fork',
      turn_id: 1,
      provider_type: undefined,
      protocol: undefined,
      input_tokens: 800,
      input_cache_read: 300,
      input_cache_creation: 400,
      output_tokens: 200,
    });
  });
});
