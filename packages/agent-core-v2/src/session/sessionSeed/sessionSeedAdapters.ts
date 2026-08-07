/**
 * `sessionSeed` domain — the workspace → session seed adapter units.
 *
 * Each adapter projects one workspace-scoped resource service into its
 * Session-scope pure-data injection contract (the seed tokens every session
 * consumer resolves): the workspace's merged skill catalog, the AGENTS.md
 * snapshot, the shared MCP connection handle, the additional-directory set,
 * and the os-level tool veto. The projection object is built per upstream
 * generation by the workspace service's own `sessionData()` /
 * `sessionProvider()` / `sessionHandle()` / `sessionInfo()` / `sessionGate()`
 * method; the adapter only owns the LIFETIME semantics the plain `extra` seed
 * could not express:
 *
 *  - live reads: the data object's getters delegate to the CURRENT backing
 *    projection, so an upstream rebuild (a new generation observed through
 *    `@ref`) never leaves consumers reading a stale closure;
 *  - change events: `onDidChange` is the adapter's own emitter — it forwards
 *    the backing projection's events and RE-FIRES when the backing view
 *    switches, telling consumers to re-pull;
 *  - hosts without a workspace layer (test hosts, harness agents): the
 *    observed upstream is absent and the adapter returns early, leaving the
 *    scope's default/extra registration (e.g. the Noop tool-policy gate)
 *    untouched.
 *
 * The units carry no DI token of their own: the session
 * assembly point constructs them explicitly (`assembleSessionSeedAdapters`,
 * the `assemble` hook of `createScopedChildHandle`) and anchors their
 * disposal into the session container's ledger. Observation (`@ref`) is
 * data-flow semantics — an upstream rebuild re-fires `onDidChange` instead
 * of cascading this adapter down. A session created with ephemeral
 * `mcpServers` passes its merged overlay handle as `sessionMcpHandle`: the
 * MCP adapter is skipped and the overlay handle is provided directly (fixed
 * at creation, like the pre-adapter inline seed).
 */

import type { ServiceClassRecipe } from '#/_base/di/fiber';
import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Emitter } from '#/_base/event';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';

export class SessionSkillCatalogDataAdapter extends Service {
  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ref(IWorkspaceSkillCatalog) upstream: LiveRef<IWorkspaceSkillCatalog>,
  ) {
    super();
    if (upstream.current === undefined) return;
    const change = this._register(new Emitter<string>());
    let backing = upstream.current.sessionData();
    let backingSubscription = backing.onDidChange((sourceId) => {
      change.fire(sourceId);
    });
    this._register({
      dispose: () => {
        backingSubscription.dispose();
      },
    });
    this._register(
      upstream.onDidChange(() => {
        if (upstream.current !== undefined) {
          backingSubscription.dispose();
          backing = upstream.current.sessionData();
          backingSubscription = backing.onDidChange((sourceId) => {
            change.fire(sourceId);
          });
        }
        change.fire('catalog');
      }),
    );
    const data: ISessionSkillCatalogData = {
      _serviceBrand: undefined,
      get ready() {
        return backing.ready;
      },
      get catalog() {
        return backing.catalog;
      },
      onDidChange: change.event,
    };
    instantiation.provide(ISessionSkillCatalogData, data);
  }
}

export class SessionInstructionsProviderAdapter extends Service {
  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ref(IWorkspaceInstructionsService) upstream: LiveRef<IWorkspaceInstructionsService>,
  ) {
    super();
    if (upstream.current === undefined) return;
    const change = this._register(new Emitter<void>());
    let backing = upstream.current.sessionProvider();
    let backingSubscription = backing.onDidChange(() => {
      change.fire();
    });
    this._register({
      dispose: () => {
        backingSubscription.dispose();
      },
    });
    this._register(
      upstream.onDidChange(() => {
        if (upstream.current !== undefined) {
          backingSubscription.dispose();
          backing = upstream.current.sessionProvider();
          backingSubscription = backing.onDidChange(() => {
            change.fire();
          });
        }
        change.fire();
      }),
    );
    const data: ISessionInstructionsProvider = {
      _serviceBrand: undefined,
      get ready() {
        return backing.ready;
      },
      get agentsMd() {
        return backing.agentsMd;
      },
      get agentsMdWarning() {
        return backing.agentsMdWarning;
      },
      get agentsMdPaths() {
        return backing.agentsMdPaths;
      },
      onDidChange: change.event,
    };
    instantiation.provide(ISessionInstructionsProvider, data);
  }
}

export class SessionMcpHandleAdapter extends Service {
  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ref(IWorkspaceMcpService) upstream: LiveRef<IWorkspaceMcpService>,
  ) {
    super();
    if (upstream.current === undefined) return;
    let backing = upstream.current.sessionHandle();
    this._register(
      upstream.onDidChange(() => {
        if (upstream.current !== undefined) {
          backing = upstream.current.sessionHandle();
        }
      }),
    );
    const handle: ISessionMcpHandle = {
      _serviceBrand: undefined,
      get ready() {
        return backing.ready;
      },
      get connectionManager() {
        return backing.connectionManager;
      },
      isBaselineServer: (name) => backing.isBaselineServer(name),
    };
    instantiation.provide(ISessionMcpHandle, handle);
  }
}

export class SessionWorkspaceInfoAdapter extends Service {
  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ref(IWorkspaceDirs) upstream: LiveRef<IWorkspaceDirs>,
  ) {
    super();
    if (upstream.current === undefined) return;
    const change = this._register(new Emitter<void>());
    let backing = upstream.current.sessionInfo();
    let backingSubscription = backing.onDidChange(() => {
      change.fire();
    });
    this._register({
      dispose: () => {
        backingSubscription.dispose();
      },
    });
    this._register(
      upstream.onDidChange(() => {
        if (upstream.current !== undefined) {
          backingSubscription.dispose();
          backing = upstream.current.sessionInfo();
          backingSubscription = backing.onDidChange(() => {
            change.fire();
          });
        }
        change.fire();
      }),
    );
    const info: ISessionWorkspaceInfo = {
      _serviceBrand: undefined,
      get ready() {
        return backing.ready;
      },
      get additionalDirs() {
        return backing.additionalDirs;
      },
      onDidChange: change.event,
    };
    instantiation.provide(ISessionWorkspaceInfo, info);
  }
}

export class SessionToolPolicyGateAdapter extends Service {
  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ref(IWorkspaceToolPolicy) upstream: LiveRef<IWorkspaceToolPolicy>,
  ) {
    super();
    if (upstream.current === undefined) return;
    const change = this._register(new Emitter<void>());
    let backing = upstream.current.sessionGate();
    let backingSubscription = backing.onDidChange(() => {
      change.fire();
    });
    this._register({
      dispose: () => {
        backingSubscription.dispose();
      },
    });
    this._register(
      upstream.onDidChange(() => {
        if (upstream.current !== undefined) {
          backingSubscription.dispose();
          backing = upstream.current.sessionGate();
          backingSubscription = backing.onDidChange(() => {
            change.fire();
          });
        }
        change.fire();
      }),
    );
    const gate: ISessionToolPolicyGate = {
      _serviceBrand: undefined,
      get disabledTools() {
        return backing.disabledTools;
      },
      onDidChange: change.event,
    };
    instantiation.provide(ISessionToolPolicyGate, gate);
  }
}

const SESSION_SEED_ADAPTERS: readonly ServiceClassRecipe[] = [
  SessionSkillCatalogDataAdapter,
  SessionInstructionsProviderAdapter,
  SessionMcpHandleAdapter,
  SessionWorkspaceInfoAdapter,
  SessionToolPolicyGateAdapter,
];

export function assembleSessionSeedAdapters(
  container: InstantiationService,
  sessionMcpHandle?: ISessionMcpHandle,
): void {
  for (const recipe of SESSION_SEED_ADAPTERS) {
    if (recipe === SessionMcpHandleAdapter && sessionMcpHandle !== undefined) {
      container.provide(ISessionMcpHandle, sessionMcpHandle);
      continue;
    }
    const adapter = container.fiberHost.constructService(recipe, undefined) as Partial<IDisposable>;
    container.anchorKernelEntry(() => {
      adapter.dispose?.();
    }, `sessionSeed:${recipe.name}`);
  }
}
