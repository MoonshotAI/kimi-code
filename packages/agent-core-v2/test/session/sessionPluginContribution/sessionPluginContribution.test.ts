/**
 * Scenario: session plugin-contribution convergence.
 *
 * Exercises the real coordinator against a stubbed App plugin boundary and a
 * real session skill catalog: catalog-kind changes reload plugin skills
 * before Agent participants run, the change waits for the whole fan-out,
 * MCP-only changes skip convergence, and a failing participant or skill
 * reload cannot block the change for everyone else.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionPluginContribution/sessionPluginContribution.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { AsyncEmitter, Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService, type PluginChangedEvent } from '#/app/plugin/plugin';
import { BuiltinSkillSource, IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { InMemorySkillDiscovery } from '#/app/skillCatalog/inMemorySkillDiscovery';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { IUserFileSkillSource, UserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import type { SkillRoot } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { ExplicitFileSkillSource, IExplicitFileSkillSource } from '#/session/sessionSkillCatalog/explicitFileSkillSource';
import { ExtraFileSkillSource, IExtraFileSkillSource } from '#/session/sessionSkillCatalog/extraFileSkillSource';
import { IWorkspaceFileSkillSource, WorkspaceFileSkillSource } from '#/session/sessionSkillCatalog/workspaceFileSkillSource';
import { IPluginSkillSource, PluginSkillSource } from '#/session/sessionSkillCatalog/pluginSkillSource';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import {
  ISessionPluginContributionService,
} from '#/session/sessionPluginContribution/sessionPluginContribution';
import { SessionPluginContributionService } from '#/session/sessionPluginContribution/sessionPluginContributionService';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubSkill } from '../../app/skillCatalog/stubs';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

const workspaceStub = {
  _serviceBrand: undefined,
  workDir: '/work',
  additionalDirs: [],
  setWorkDir: () => {},
  setAdditionalDirs: () => {},
  resolve: (rel: string) => rel,
  isWithin: () => true,
  assertAllowed: (p: string) => p,
  addAdditionalDir: () => {},
  removeAdditionalDir: () => {},
} as unknown as ISessionWorkspaceContext;

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface PluginBoundary {
  readonly change: AsyncEmitter<PluginChangedEvent>;
  skillRoots: readonly SkillRoot[] | (() => Promise<readonly SkillRoot[]>);
}

function pluginStub(boundary: PluginBoundary): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidChange: boundary.change.event,
    onDidReload: Event.None as IPluginService['onDidReload'],
    pluginSkillRoots:
      typeof boundary.skillRoots === 'function'
        ? boundary.skillRoots
        : async () => boundary.skillRoots as readonly SkillRoot[],
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
    listPluginCommands: async () => [],
  } as unknown as IPluginService;
}

function makeHost(boundary: PluginBoundary, store?: InMemorySkillDiscovery) {
  const host = createScopedTestHost([
    stubPair(ISkillDiscovery, store ?? new InMemorySkillDiscovery()),
    stubPair(IBootstrapService, stubBootstrap('/home')),
    stubPair(IConfigService, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidSectionChange: () => ({ dispose: () => {} }),
      get: () => undefined,
    } as unknown as IConfigService),
    stubPair(ILogService, noopLog),
    stubPair(ISkillCatalogRuntimeOptions, {
      _serviceBrand: undefined,
    } as unknown as ISkillCatalogRuntimeOptions),
    stubPair(IPluginService, pluginStub(boundary)),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, workspaceStub),
  ]);
  return { host, session };
}

describe('SessionPluginContributionService', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionStateService, SessionStateService);
    registerScopedService(LifecycleScope.App, IBuiltinSkillSource, BuiltinSkillSource);
    registerScopedService(LifecycleScope.App, IUserFileSkillSource, UserFileSkillSource);
    registerScopedService(LifecycleScope.Session, ISessionSkillCatalog, SessionSkillCatalogService);
    registerScopedService(LifecycleScope.Session, IExplicitFileSkillSource, ExplicitFileSkillSource);
    registerScopedService(LifecycleScope.Session, IExtraFileSkillSource, ExtraFileSkillSource);
    registerScopedService(LifecycleScope.Session, IWorkspaceFileSkillSource, WorkspaceFileSkillSource);
    registerScopedService(LifecycleScope.Session, IPluginSkillSource, PluginSkillSource);
    registerScopedService(
      LifecycleScope.Session,
      ISessionPluginContributionService,
      SessionPluginContributionService,
    );
  });

  it('reloads plugin skills before notifying participants and waits for the whole fan-out', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const boundary: PluginBoundary = { change, skillRoots: [] };
    const store = new InMemorySkillDiscovery();
    const { host, session } = makeHost(boundary, store);
    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      const coordinator = session.accessor.get(ISessionPluginContributionService);
      await catalog.load();
      expect(catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeUndefined();

      boundary.skillRoots = [
        { path: '/plugins/demo/skills', source: 'extra', plugin: { id: 'demo' } },
      ];
      store.setPluginSkills([
        stubSkill('demo-skill', { source: 'extra', plugin: { id: 'demo' } }),
      ]);
      const participantCalled = deferred();
      const release = deferred();
      const skillStateAtParticipant: string[] = [];
      const subscription = coordinator.onDidChange((event) => {
        skillStateAtParticipant.push(
          catalog.catalog.getPluginSkill('demo', 'demo-skill') === undefined
            ? 'missing'
            : 'present',
        );
        participantCalled.resolve();
        event.waitUntil(release.promise);
      });
      let settled = false;
      const fired = change
        .fireAsync({ kind: 'catalog' }, new AbortController().signal)
        .then(() => {
          settled = true;
        });

      await participantCalled.promise;
      expect(skillStateAtParticipant).toEqual(['present']);
      expect(settled).toBe(false);

      release.resolve();
      await fired;
      expect(settled).toBe(true);
      subscription.dispose();
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('skips convergence entirely for MCP-only changes', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const { host, session } = makeHost({ change, skillRoots: [] });
    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      const coordinator = session.accessor.get(ISessionPluginContributionService);
      await catalog.load();

      let participants = 0;
      const subscription = coordinator.onDidChange(() => {
        participants += 1;
      });
      const catalogChanges: string[] = [];
      const catalogSubscription = catalog.onDidChange((sourceId) => {
        catalogChanges.push(sourceId);
      });

      await change.fireAsync({ kind: 'mcp' }, new AbortController().signal);

      expect(participants).toBe(0);
      expect(catalogChanges).toEqual([]);
      subscription.dispose();
      catalogSubscription.dispose();
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('notifies remaining participants when the plugin skill reload fails', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    let failReads = false;
    const boundary: PluginBoundary = {
      change,
      skillRoots: async () => {
        if (failReads) throw new Error('broken installed.json');
        return [];
      },
    };
    const { host, session } = makeHost(boundary);
    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      const coordinator = session.accessor.get(ISessionPluginContributionService);
      await catalog.load();
      failReads = true;

      let participants = 0;
      const subscription = coordinator.onDidChange(() => {
        participants += 1;
      });

      await change.fireAsync({ kind: 'catalog' }, new AbortController().signal);

      expect(participants).toBe(1);
      subscription.dispose();
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('lets a rejected participant fail without blocking the change or other participants', async () => {
    const change = new AsyncEmitter<PluginChangedEvent>();
    const { host, session } = makeHost({ change, skillRoots: [] });
    try {
      const catalog = session.accessor.get(ISessionSkillCatalog);
      const coordinator = session.accessor.get(ISessionPluginContributionService);
      await catalog.load();

      let healthy = 0;
      coordinator.onDidChange((event) => {
        event.waitUntil(Promise.reject(new Error('boom')));
      });
      coordinator.onDidChange((event) => {
        healthy += 1;
        event.waitUntil(Promise.resolve());
      });

      await change.fireAsync({ kind: 'catalog' }, new AbortController().signal);

      expect(healthy).toBe(1);
    } finally {
      host.dispose();
      change.dispose();
    }
  });

  it('cuts off a hung participant after the convergence timeout', async () => {
    vi.useFakeTimers();
    try {
      const change = new AsyncEmitter<PluginChangedEvent>();
      const { host, session } = makeHost({ change, skillRoots: [] });
      try {
        const catalog = session.accessor.get(ISessionSkillCatalog);
        const coordinator = session.accessor.get(ISessionPluginContributionService);
        await catalog.load();

        coordinator.onDidChange((event) => {
          event.waitUntil(new Promise(() => {}));
        });
        let settled = false;
        const fired = change
          .fireAsync({ kind: 'catalog' }, new AbortController().signal)
          .then(() => {
            settled = true;
          });

        await vi.advanceTimersByTimeAsync(30_000);
        await fired;

        expect(settled).toBe(true);
      } finally {
        host.dispose();
        change.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
