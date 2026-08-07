/**
 * sessionSeed adapters — unit tests over the real scope tree.
 *
 * Each adapter observes its workspace upstream through `@ref` and provides
 * the Session-scope seed token during the scope's `assemble` hook. Covered
 * per adapter: live reads across an upstream generation swap (getters never
 * serve a stale closure), `onDidChange` forwarding from the current backing
 * projection, the re-fire on upstream availability change (switch backing
 * view → re-fire), and the early return when no workspace layer exists
 * (the seed stays unprovided; the Noop tool-policy gate default survives).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
  type ScopeSeed,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { assembleSessionSeedAdapters } from '#/session/sessionSeed/sessionSeedAdapters';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { NoopSessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGateService';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import {
  IWorkspaceInstructionsService,
  type WorkspaceInstructionsSnapshot,
} from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService, type ISessionMcpOverlay } from '#/workspace/workspaceMcp/workspaceMcp';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';

class WorkspaceSkillCatalogStub implements IWorkspaceSkillCatalog {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  catalog: SkillCatalog;
  private readonly changeEmitter = new Emitter<string>();
  readonly onDidChange: Event<string> = this.changeEmitter.event;

  constructor(catalog: SkillCatalog) {
    this.catalog = catalog;
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  fire(sourceId: string): void {
    this.changeEmitter.fire(sourceId);
  }

  sessionData(): ISessionSkillCatalogData {
    const currentCatalog = (): SkillCatalog => this.catalog;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get catalog() {
        return currentCatalog();
      },
    };
  }
}

class WorkspaceInstructionsStub implements IWorkspaceInstructionsService {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  snapshot: WorkspaceInstructionsSnapshot;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(snapshot: WorkspaceInstructionsSnapshot) {
    this.snapshot = snapshot;
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  fire(): void {
    this.changeEmitter.fire();
  }

  sessionProvider(): ISessionInstructionsProvider {
    const currentAgentsMd = (): string | undefined => this.snapshot.agentsMd;
    const currentWarning = (): string | undefined => this.snapshot.agentsMdWarning;
    const currentPaths = (): readonly string[] | undefined => this.snapshot.agentsMdPaths;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get agentsMd() {
        return currentAgentsMd();
      },
      get agentsMdWarning() {
        return currentWarning();
      },
      get agentsMdPaths() {
        return currentPaths();
      },
    };
  }
}

class WorkspaceMcpStub implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();

  constructor(private readonly manager: McpConnectionManager) {}

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(): ISessionMcpHandle {
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: this.manager,
      isBaselineServer: () => true,
    };
  }

  sessionOverlay(): ISessionMcpOverlay {
    return { handle: this.sessionHandle(), shutdown: () => Promise.resolve() };
  }
}

class WorkspaceDirsStub implements IWorkspaceDirs {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  additionalDirs: readonly string[];
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(additionalDirs: readonly string[]) {
    this.additionalDirs = additionalDirs;
  }

  addDir(): Promise<never> {
    return Promise.reject(new Error('not implemented'));
  }

  mergeAdditionalDirs(): Promise<void> {
    return Promise.resolve();
  }

  fire(): void {
    this.changeEmitter.fire();
  }

  sessionInfo(): ISessionWorkspaceInfo {
    const currentDirs = (): readonly string[] => this.additionalDirs;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get additionalDirs() {
        return currentDirs();
      },
    };
  }
}

class WorkspaceToolPolicyStub implements IWorkspaceToolPolicy {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(private readonly disabled: readonly string[]) {}

  disabledTools(): readonly string[] {
    return this.disabled;
  }

  fire(): void {
    this.changeEmitter.fire();
  }

  sessionGate(): ISessionToolPolicyGate {
    const current = (): readonly string[] => this.disabledTools();
    return {
      _serviceBrand: undefined,
      onDidChange: this.onDidChange,
      get disabledTools() {
        return current();
      },
    };
  }
}

function catalogSentinel(tag: string): SkillCatalog {
  return { tag } as unknown as SkillCatalog;
}

function managerSentinel(tag: string): McpConnectionManager {
  return { tag } as unknown as McpConnectionManager;
}

describe('sessionSeed adapters', () => {
  let host: ScopedTestHost | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionToolPolicyGate,
      NoopSessionToolPolicyGate,
      ScopeActivation.OnScopeCreated,
      'sessionToolPolicyGate',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function buildSession(workspaceStubs: ScopeSeed): { workspace: Scope; session: Scope } {
    host = createScopedTestHost();
    const workspace = host.app.createChild(LifecycleScope.Workspace, 'ws', {
      extra: workspaceStubs,
    });
    const session = workspace.createChild(LifecycleScope.Session, 's1', {
      assemble: assembleSessionSeedAdapters,
    });
    return { workspace, session };
  }

  describe('SessionSkillCatalogDataAdapter', () => {
    it('projects the current upstream and live-reads within its generation', () => {
      const gen1 = new WorkspaceSkillCatalogStub(catalogSentinel('gen1'));
      const { session } = buildSession([stubPair(IWorkspaceSkillCatalog, gen1)]);
      const data = session.accessor.get(ISessionSkillCatalogData);

      expect(data.catalog).toBe(gen1.catalog);
      const mutated = catalogSentinel('gen1-mutated');
      gen1.catalog = mutated;
      expect(data.catalog).toBe(mutated);
    });

    it('forwards the backing projection’s onDidChange with its payload', () => {
      const gen1 = new WorkspaceSkillCatalogStub(catalogSentinel('gen1'));
      const { session } = buildSession([stubPair(IWorkspaceSkillCatalog, gen1)]);
      const data = session.accessor.get(ISessionSkillCatalogData);
      const seen: string[] = [];
      data.onDidChange((sourceId) => seen.push(sourceId));

      gen1.fire('workspace');
      expect(seen).toEqual(['workspace']);
    });

    it('reads the new generation after an upstream swap and re-fires onDidChange', () => {
      const gen1 = new WorkspaceSkillCatalogStub(catalogSentinel('gen1'));
      const gen2 = new WorkspaceSkillCatalogStub(catalogSentinel('gen2'));
      const { workspace, session } = buildSession([stubPair(IWorkspaceSkillCatalog, gen1)]);
      const data = session.accessor.get(ISessionSkillCatalogData);
      const seen: string[] = [];
      data.onDidChange((sourceId) => seen.push(sourceId));

      workspace.instantiation.provide(IWorkspaceSkillCatalog, gen2);

      expect(seen).toEqual(['catalog']);
      expect(data.catalog).toBe(gen2.catalog);

      gen2.fire('plugin');
      expect(seen).toEqual(['catalog', 'plugin']);
      gen1.fire('stale');
      expect(seen).toEqual(['catalog', 'plugin']);
    });

    it('re-fires on upstream removal while reads keep the last backing view', () => {
      const gen1 = new WorkspaceSkillCatalogStub(catalogSentinel('gen1'));
      const { workspace, session } = buildSession([stubPair(IWorkspaceSkillCatalog, gen1)]);
      const data = session.accessor.get(ISessionSkillCatalogData);
      const seen: string[] = [];
      data.onDidChange((sourceId) => seen.push(sourceId));

      workspace.instantiation.unprovide(IWorkspaceSkillCatalog);

      expect(seen).toEqual(['catalog']);
      expect(data.catalog).toBe(gen1.catalog);
    });

    it('provides nothing when no workspace layer exists', () => {
      const { session } = buildSession([]);
      expect(() => session.accessor.get(ISessionSkillCatalogData)).toThrow(/unknown service/);
    });
  });

  describe('SessionInstructionsProviderAdapter', () => {
    it('live-reads the snapshot across an upstream swap and re-fires', () => {
      const gen1 = new WorkspaceInstructionsStub({ agentsMd: 'one', agentsMdWarning: undefined , agentsMdPaths: undefined });
      const gen2 = new WorkspaceInstructionsStub({ agentsMd: 'two', agentsMdWarning: 'big' , agentsMdPaths: undefined });
      const { workspace, session } = buildSession([stubPair(IWorkspaceInstructionsService, gen1)]);
      const provider = session.accessor.get(ISessionInstructionsProvider);
      let fired = 0;
      provider.onDidChange(() => fired++);

      expect(provider.agentsMd).toBe('one');
      gen1.snapshot = { agentsMd: 'one-b', agentsMdWarning: undefined , agentsMdPaths: undefined };
      expect(provider.agentsMd).toBe('one-b');

      workspace.instantiation.provide(IWorkspaceInstructionsService, gen2);
      expect(fired).toBe(1);
      expect(provider.agentsMd).toBe('two');
      expect(provider.agentsMdWarning).toBe('big');

      gen2.fire();
      expect(fired).toBe(2);
      gen1.fire();
      expect(fired).toBe(2);
    });

    it('provides nothing when no workspace layer exists', () => {
      const { session } = buildSession([]);
      expect(() => session.accessor.get(ISessionInstructionsProvider)).toThrow(/unknown service/);
    });
  });

  describe('SessionMcpHandleAdapter', () => {
    it('live-reads the connection manager across an upstream swap', () => {
      const managerA = managerSentinel('a');
      const managerB = managerSentinel('b');
      const gen2 = new WorkspaceMcpStub(managerB);
      const { workspace, session } = buildSession([
        stubPair(IWorkspaceMcpService, new WorkspaceMcpStub(managerA)),
      ]);
      const handle = session.accessor.get(ISessionMcpHandle);

      expect(handle.connectionManager).toBe(managerA);
      workspace.instantiation.provide(IWorkspaceMcpService, gen2);
      expect(handle.connectionManager).toBe(managerB);
      expect(handle.ready).toBe(gen2.ready);
    });

    it('provides nothing when no workspace layer exists', () => {
      const { session } = buildSession([]);
      expect(() => session.accessor.get(ISessionMcpHandle)).toThrow(/unknown service/);
    });
  });

  describe('SessionWorkspaceInfoAdapter', () => {
    it('live-reads additionalDirs across an upstream swap and re-fires', () => {
      const gen1 = new WorkspaceDirsStub(['/a']);
      const gen2 = new WorkspaceDirsStub(['/b']);
      const { workspace, session } = buildSession([stubPair(IWorkspaceDirs, gen1)]);
      const info = session.accessor.get(ISessionWorkspaceInfo);
      let fired = 0;
      info.onDidChange(() => fired++);

      expect(info.additionalDirs).toEqual(['/a']);
      workspace.instantiation.provide(IWorkspaceDirs, gen2);
      expect(fired).toBe(1);
      expect(info.additionalDirs).toEqual(['/b']);

      gen2.additionalDirs = ['/b', '/c'];
      gen2.fire();
      expect(info.additionalDirs).toEqual(['/b', '/c']);
      expect(fired).toBe(2);
      gen1.fire();
      expect(fired).toBe(2);
    });

    it('provides nothing when no workspace layer exists', () => {
      const { session } = buildSession([]);
      expect(() => session.accessor.get(ISessionWorkspaceInfo)).toThrow(/unknown service/);
    });
  });

  describe('SessionToolPolicyGateAdapter', () => {
    it('shadows the Noop default and live-reads across an upstream swap', () => {
      const gen1 = new WorkspaceToolPolicyStub(['Bash']);
      const gen2 = new WorkspaceToolPolicyStub(['Bash', 'CronCreate']);
      const { workspace, session } = buildSession([stubPair(IWorkspaceToolPolicy, gen1)]);
      const gate = session.accessor.get(ISessionToolPolicyGate);
      let fired = 0;
      gate.onDidChange(() => fired++);

      expect(gate).not.toBeInstanceOf(NoopSessionToolPolicyGate);
      expect(gate.disabledTools).toEqual(['Bash']);
      workspace.instantiation.provide(IWorkspaceToolPolicy, gen2);
      expect(fired).toBe(1);
      expect(gate.disabledTools).toEqual(['Bash', 'CronCreate']);
    });

    it('keeps the Noop default when no workspace layer exists', () => {
      const { session } = buildSession([]);
      const gate = session.accessor.get(ISessionToolPolicyGate);
      expect(gate).toBeInstanceOf(NoopSessionToolPolicyGate);
      expect(gate.disabledTools).toEqual([]);
    });
  });

  describe('assembly ordering', () => {
    interface SeedProbe {
      readonly _serviceBrand: undefined;
      readonly catalogAtActivation: SkillCatalog;
    }
    const ISeedProbe = createDecorator<SeedProbe>('testSessionSeedProbe');
    class SeedProbeService implements SeedProbe {
      declare readonly _serviceBrand: undefined;
      readonly catalogAtActivation: SkillCatalog;
      constructor(@ISessionSkillCatalogData data: ISessionSkillCatalogData) {
        this.catalogAtActivation = data.catalog;
      }
    }

    it('provides the seed tokens before OnScopeCreated services activate', () => {
      registerScopedService(
        LifecycleScope.Session,
        ISeedProbe,
        SeedProbeService,
        ScopeActivation.OnScopeCreated,
        'test',
      );
      const gen1 = new WorkspaceSkillCatalogStub(catalogSentinel('gen1'));
      const { session } = buildSession([stubPair(IWorkspaceSkillCatalog, gen1)]);
      expect(session.accessor.get(ISeedProbe).catalogAtActivation).toBe(gen1.catalog);
    });
  });
});
