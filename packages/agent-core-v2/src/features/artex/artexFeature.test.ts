import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { TestInstantiationService, createScopedTestHost } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  ARTEX_FLAG_ID,
  _setArtexFeatureAssembledForTests,
  isArtexFeatureAssembled,
} from './artex';
import { ArtexFeature } from './artexFeature';
import { IArtexModeService } from './agent/artexMode';
import { ArtexModeService } from './agent/artexModeService';
import { artexKey } from './agent/artexOps';
import { ARTEX_MAIN_AGENT_TOOL_NAMES, ARTEX_PROFILES } from './profiles/artexProfiles';
import { ArtexSessionContext, IArtexSessionContext } from './session/artexSessionContext';
import { ARTEX_TOOLS } from './tools/index';

import { stubFlag } from '../../../test/app/flag/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../../test/wire/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('ArtexFeature — experimental flag gating', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(ArtexFeature);
  });

  it('assembles an empty unit when the artex flag is off', () => {
    const flags = stubFlag(false);
    const host = createScopedTestHost([[IFlagService, flags]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toEqual(['artex']);
    expect(manager.contributedServices()).toHaveLength(0);
    expect(isArtexFeatureAssembled(flags)).toBe(false);
    expect(collectionViewOf(host.app, AgentProfileContribution).items).toHaveLength(0);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('contributes tools, profiles, and services when the artex flag is on', () => {
    const flags = stubFlag((id) => id === ARTEX_FLAG_ID);
    const host = createScopedTestHost([[IFlagService, flags]]);
    expect(isArtexFeatureAssembled(flags)).toBe(true);
    const profiles = collectionViewOf(host.app, AgentProfileContribution).items;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.contribution.profiles).toHaveLength(ARTEX_PROFILES.length);
    expect(profiles[0]!.sourceId).toBe('feature:artex');

    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const tools = collectionViewOf(agent, AgentToolContribution).items.map(
      (record) => record.options.name,
    );
    expect(tools.toSorted()).toEqual(ARTEX_TOOLS.map((tool) => tool.name).toSorted());
    host.dispose();
  });

  it('clears the assembly marker when the feature unit unloads', async () => {
    const flags = stubFlag((id) => id === ARTEX_FLAG_ID);
    const host = createScopedTestHost([[IFlagService, flags]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(isArtexFeatureAssembled(flags)).toBe(true);

    await manager.unprovideUnit('artex');

    expect(isArtexFeatureAssembled(flags)).toBe(false);
    host.dispose();
  });
});

describe('ArtexModeService — persistence, tool activation, and restore', () => {
  let disposables: DisposableStore;
  let workspaceDir: string;
  let activeTools: Set<string>;
  let addActiveTool: ReturnType<typeof vi.fn>;
  let removeActiveTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    disposables = new DisposableStore();
    workspaceDir = await mkdtemp(join(tmpdir(), 'artex-mode-'));
    activeTools = new Set(['Bash', 'Read']);
    addActiveTool = vi.fn((name: string) => {
      activeTools.add(name);
    });
    removeActiveTool = vi.fn((name: string) => {
      activeTools.delete(name);
    });
    _setArtexFeatureAssembledForTests(true);
  });

  afterEach(async () => {
    _setArtexFeatureAssembledForTests(undefined);
    disposables.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function createServiceHost(options: {
    readonly agentId?: string;
    readonly flagEnabled?: boolean;
    readonly log?: IAppendLogStore;
    readonly storage?: IFileSystemStorageService;
  } = {}) {
    const ix = disposables.add(new TestInstantiationService());
    const storage = options.storage ?? new InMemoryStorageService();
    const log =
      options.log ??
      (() => {
        ix.stub(IFileSystemStorageService, storage);
        ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
        return ix.get(IAppendLogStore);
      })();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IAppendLogStore, log);
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentStateService, new AgentStateService());
    const scopeCtx = makeAgentScopeContext({
      agentId: options.agentId ?? 'main',
      agentScope: '',
    });
    ix.stub(IAgentScopeContext, scopeCtx);
    registerTestAgentWire(ix, testWireScope('wire', 'artex-mode-test'), {
      agentId: scopeCtx.agentId,
      eventBus: ix.get(IEventBus),
      log,
    });
    const dispatcher = registerTestEventDispatcher(ix);
    ix.stub(IFlagService, stubFlag(options.flagEnabled ?? true));
    ix.stub(IAgentReminderService, {
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentReminderService);
    ix.stub(IAgentLoopService, {
      addActiveTool,
      removeActiveTool,
      getActiveToolNames: () => [...activeTools],
    } as unknown as IAgentLoopService);
    ix.stub(ISessionContext, { sessionDir: workspaceDir } as unknown as ISessionContext);
    ix.set(IArtexSessionContext, new SyncDescriptor(ArtexSessionContext));
    ix.get(IArtexSessionContext);
    ix.set(IArtexModeService, new SyncDescriptor(ArtexModeService));
    const service = ix.get(IArtexModeService);
    return { ix, service, dispatcher, log, storage };
  }

  it('activates main-agent tools and persists state + explorationId on enter and exit', async () => {
    const { ix, service, dispatcher } = createServiceHost();
    await dispatcher.restore();

    service.enter(42);
    expect(service.isActive).toBe(true);
    expect(ix.get(IAgentStateService).get(artexKey)).toEqual({
      active: true,
      explorationId: 42,
    });
    expect(ix.get(IArtexSessionContext).getActiveExplorationId()).toBe(42);
    for (const name of ARTEX_MAIN_AGENT_TOOL_NAMES) {
      expect(activeTools.has(name)).toBe(true);
    }

    service.exit('user');
    expect(service.isActive).toBe(false);
    expect(ix.get(IAgentStateService).get(artexKey)).toEqual({
      active: false,
      explorationId: 42,
    });
    for (const name of ARTEX_MAIN_AGENT_TOOL_NAMES) {
      expect(activeTools.has(name)).toBe(false);
    }
  });

  it('restores active mode, activeExplorationId, and main tools across session reload', async () => {
    const storage = new InMemoryStorageService();
    const first = createServiceHost({ storage });
    await first.dispatcher.restore();
    first.service.enter(77);
    await first.dispatcher.flush();

    activeTools = new Set(['Bash', 'Read']);
    const secondIx = disposables.add(new TestInstantiationService());
    secondIx.stub(IFileSystemStorageService, storage);
    secondIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    secondIx.set(IEventBus, new SyncDescriptor(EventBusService));
    secondIx.set(IAgentStateService, new AgentStateService());
    const scopeCtx = makeAgentScopeContext({ agentId: 'main', agentScope: '' });
    secondIx.stub(IAgentScopeContext, scopeCtx);
    registerTestAgentWire(secondIx, testWireScope('wire', 'artex-mode-test'), {
      agentId: 'main',
      eventBus: secondIx.get(IEventBus),
      log: secondIx.get(IAppendLogStore),
    });
    const secondDispatcher = registerTestEventDispatcher(secondIx);
    secondIx.stub(IFlagService, stubFlag(true));
    secondIx.stub(IAgentReminderService, {
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentReminderService);
    secondIx.stub(IAgentLoopService, {
      addActiveTool,
      removeActiveTool,
      getActiveToolNames: () => [...activeTools],
    } as unknown as IAgentLoopService);
    secondIx.stub(ISessionContext, { sessionDir: workspaceDir } as unknown as ISessionContext);
    secondIx.set(IArtexSessionContext, new SyncDescriptor(ArtexSessionContext));
    secondIx.get(IArtexSessionContext);
    secondIx.set(IArtexModeService, new SyncDescriptor(ArtexModeService));
    const restoredService = secondIx.get(IArtexModeService);

    await secondDispatcher.restore();

    expect(restoredService.isActive).toBe(true);
    expect(secondIx.get(IArtexSessionContext).getActiveExplorationId()).toBe(77);
    for (const name of ARTEX_MAIN_AGENT_TOOL_NAMES) {
      expect(activeTools.has(name)).toBe(true);
    }
  });

  it('does not enter when flag is off or on non-main subagent', async () => {
    const off = createServiceHost({ flagEnabled: false });
    await off.dispatcher.restore();
    off.service.enter(1);
    expect(off.service.isActive).toBe(false);

    const sub = createServiceHost({ agentId: 'agent-1', flagEnabled: true });
    await sub.dispatcher.restore();
    sub.service.enter(1);
    expect(sub.service.isActive).toBe(false);
  });
});
