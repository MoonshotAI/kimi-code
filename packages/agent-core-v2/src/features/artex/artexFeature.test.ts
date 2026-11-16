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
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { sessionAgentConfigPartialSchema } from '#/app/sessionLegacy/sessionProtocol';
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
import { IArtexOrchestrator } from './engine/artexOrchestrator';
import { ArtexSessionContext, IArtexSessionContext } from './session/artexSessionContext';
import { ArtexSessionService, IArtexSessionService } from './session/artexSessionService';
import { ArtexGraphStoreProvider, IArtexGraphStoreProvider } from './store/artexGraphStoreProvider';
import { ArtexTrafficStoreProvider, IArtexTrafficStoreProvider } from './store/artexTrafficStoreProvider';
import { ArtexWorkStoreProvider, IArtexWorkStoreProvider } from './store/artexWorkStoreProvider';
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

    const statusEvents: Array<{ artexMode?: boolean; artexExplorationId?: number }> = [];
    ix.get(IEventBus).subscribe(AgentStatusUpdated, (ev) => {
      if (ev.artexMode !== undefined) {
        statusEvents.push({
          artexMode: ev.artexMode,
          artexExplorationId: ev.artexExplorationId,
        });
      }
    });

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
    expect(statusEvents).toEqual([
      { artexMode: true, artexExplorationId: 42 },
      { artexMode: false, artexExplorationId: undefined },
    ]);
  });

  it('validates artex_mode and artex_exploration_id in SessionAgentConfigPartial', () => {
    const parsed = sessionAgentConfigPartialSchema.parse({
      artex_mode: true,
      artex_exploration_id: 7,
    });
    expect(parsed).toEqual({ artex_mode: true, artex_exploration_id: 7 });
    expect(() =>
      sessionAgentConfigPartialSchema.parse({ artex_exploration_id: 0 }),
    ).toThrow();
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

describe('IArtexSessionService — lifecycle, store facade, and events', () => {
  let disposables: DisposableStore;
  let workspaceDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    workspaceDir = await mkdtemp(join(tmpdir(), 'artex-session-svc-'));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('registers IArtexSessionService in LifecycleScope.Session when artex flag is on', () => {
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
    const flags = stubFlag((id) => id === ARTEX_FLAG_ID);
    const host = createScopedTestHost([[IFlagService, flags]]);
    const sessionScope = host.child(LifecycleScope.Session, 'sess-1');
    const services = host.app.accessor
      .get(IFeatureManager)
      .contributedServices()
      .filter((entry) => entry.scope === LifecycleScope.Session)
      .map((entry) => entry.id);
    expect(services).toContain(IArtexSessionService);
    expect(sessionScope).toBeDefined();
    host.dispose();
  });

  it('exposes exploration lifecycle, graph/work/traffic operations, and emits domain events', async () => {
    const ix = disposables.add(new TestInstantiationService());
    const bus = disposables.add(new EventBusService());
    ix.stub(ISessionEventBus, bus);
    ix.stub(ISessionContext, { sessionDir: workspaceDir, sessionId: 's1' } as unknown as ISessionContext);
    ix.set(IArtexGraphStoreProvider, new SyncDescriptor(ArtexGraphStoreProvider));
    ix.set(IArtexWorkStoreProvider, new SyncDescriptor(ArtexWorkStoreProvider));
    ix.set(IArtexTrafficStoreProvider, new SyncDescriptor(ArtexTrafficStoreProvider));
    ix.set(IArtexSessionContext, new SyncDescriptor(ArtexSessionContext));

    const startMock = vi.fn(() => ({
      explorationId: 1,
      completion: Promise.resolve({
        waves: 0,
        dispatched: 0,
        settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
        goalMet: false,
        stalled: false,
        stopped: false,
      }),
      stop: () => {},
    }));
    const pauseMock = vi.fn(async () => true);
    const stopMock = vi.fn(() => true);
    const pauseIntentMock = vi.fn(() => false);
    const abortIntentMock = vi.fn(() => false);
    const notifyMock = vi.fn();
    ix.stub(IArtexOrchestrator, {
      start: startMock,
      pause: pauseMock,
      stop: stopMock,
      pauseIntent: pauseIntentMock,
      abortIntent: abortIntentMock,
      notifyGraphChanged: notifyMock,
      getStatus: (id: number) => ({
        explorationId: id,
        running: true,
        paused: false,
        activeWorkers: 0,
        waves: 0,
        dispatched: 0,
        settled: { done: 0, exhausted: 0, blocked: 0, stopped: 0, paused: 0 },
        goalMet: false,
        stalled: false,
        stopped: false,
      }),
    } as unknown as IArtexOrchestrator);

    ix.set(IArtexSessionService, new SyncDescriptor(ArtexSessionService));
    const svc = ix.get(IArtexSessionService);

    const emitted: string[] = [];
    bus.subscribe((ev) => {
      emitted.push(ev.type);
    });

    expect((await svc.status()).active).toBe(false);

    const started = await svc.start({ goal: 'audit api', description: 'https://api.example.test' });
    expect(started.explorationId).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(1);

    await svc.control({ action: 'pause' });
    expect(pauseMock).toHaveBeenCalledWith(1);
    await svc.control({ action: 'resume' });
    expect(startMock).toHaveBeenCalledTimes(2);
    await svc.control({ action: 'stop' });
    expect(stopMock).toHaveBeenCalledWith(1);

    const graphStore = ix.get(IArtexGraphStoreProvider).open(workspaceDir, 1);
    const workStore = ix.get(IArtexWorkStoreProvider).open(workspaceDir);

    const blockedIntent = await graphStore.addIntent({ summary: 'blocked probe' }, 5);
    await graphStore.setIntentState(blockedIntent, 'blocked');
    const rerun = await svc.control({ action: 'rerun_blocked' });
    expect(rerun.reopened).toBe(1);
    expect((await graphStore.getNode(blockedIntent))?.state).toBe('open');

    await graphStore.setIntentState(blockedIntent, 'running');
    await svc.intentControl({ intentId: blockedIntent, action: 'pause' });
    expect((await graphStore.getNode(blockedIntent))?.state).toBe('paused');
    await svc.intentControl({ intentId: blockedIntent, action: 'resume' });
    expect((await graphStore.getNode(blockedIntent))?.state).toBe('open');
    await svc.intentControl({ intentId: blockedIntent, action: 'cancel', reason: 'out of scope' });
    expect((await graphStore.getNode(blockedIntent))?.state).toBe('deleted');

    await graphStore.appendActivity({ nodeId: blockedIntent, actor: 'worker-1', kind: 'tool_use', summary: 'curl /api' });
    const act = await svc.activity({ nodeId: blockedIntent });
    expect(act.total).toBe(1);

    const addedGoal = await svc.addGoal({ text: 'check admin', category: 'auth' });
    expect((await svc.goals()).some((g) => g.id === addedGoal.id)).toBe(true);
    const editedGoal = await svc.editGoal({ goalId: addedGoal.id, text: 'check admin panel', state: 'met' });
    expect(editedGoal.state).toBe('met');
    expect((await svc.deleteGoal({ goalId: addedGoal.id })).deleted).toBe(true);

    const cons = await svc.setConstraints({ entries: [{ kind: 'deny', text: 'no DoS' }] });
    expect(cons.constraints).toHaveLength(1);
    expect(cons.rendered).toContain('no DoS');
    expect((await svc.constraints()).constraints).toHaveLength(1);

    const addedScope = await svc.addScope({ kind: 'root_domain', value: 'example.test' });
    expect('taskScope' in addedScope).toBe(true);
    const scopeList = await svc.scope();
    expect(scopeList.taskScope).toHaveLength(1);
    if ('taskScope' in addedScope) {
      expect((await svc.deleteScope({ scopeId: addedScope.taskScope.id })).deleted).toBe(true);
    }

    const savedCred = await svc.saveCredential({
      domain: 'example.test',
      username: 'alice',
      password: 'secret',
    });
    expect(savedCred.password).not.toBe('secret');
    expect(savedCred.hasPassword).toBe(true);
    expect(await svc.credentials()).toHaveLength(1);
    expect((await svc.deleteCredential({ credentialId: savedCred.id })).deleted).toBe(true);

    await workStore.upsertAsset({ type: 'subdomain', domain: 'a.example.test' }, 1);
    await workStore.addTaskScope(1, 'root_domain', 'example.test', 'declared', 'manual');
    const cov = await svc.coverage();
    expect(cov.denominator).toBe(1);
    const untested = await svc.untestedAssets();
    expect(untested.total).toBe(1);

    const ingested = await svc.ingestTraffic({
      entries: {
        method: 'GET',
        url: 'https://api.example.test/users',
        status: 200,
        respHead: 'HTTP/1.1 200 OK\nContent-Type: application/json\n',
        respBody: '{"users":["root"]}',
      },
    });
    expect(ingested.count).toBe(1);
    expect(await svc.trafficHosts()).toHaveLength(1);
    expect(await svc.trafficSearch({ host: 'api.example.test' })).toHaveLength(1);
    expect((await svc.trafficExchange(ingested.ids[0]!))?.response).toContain('"root"');

    const findingId = await graphStore.addNode({
      kind: 'finding',
      payload: { vulnclass: 'idor', name: 'user dump', summary: 'unauthenticated dump' },
      priority: 5,
      state: 'confirmed',
    });
    expect(await svc.findings()).toHaveLength(1);
    const patched = await svc.patchFinding({ nodeId: findingId, severity: 'high' });
    expect((patched.payload as { severity?: string }).severity).toBe('high');
    expect((await svc.nodeDetail(findingId)).findingId).toBe(findingId);
    expect((await svc.graph()).nodes.length).toBeGreaterThan(0);

    const pin = await workStore.createTargetPin({
      taskId: 1,
      host: 'api.example.test',
      port: 443,
      pinnedIps: ['93.184.216.34'],
      resolver: 'system',
    });
    expect(await svc.targetPins()).toHaveLength(1);
    expect((await svc.revokeTargetPin({ pinId: pin.id })).revoked).toBe(true);

    expect(emitted).toContain('artex.exploration.updated');
    expect(emitted).toContain('artex.activity.appended');
    expect(emitted).toContain('artex.traffic.captured');
    expect(emitted).toContain('artex.finding.reported');
  });
});
