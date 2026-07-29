/**
 * `sessionAgentProfileCatalog` domain (L3) — `ISessionAgentProfileCatalog`
 * implementation.
 *
 * The Session-scope business view over the workspace's merged agent-profile
 * catalog: the discovery/merge/rescan work lives on the Workspace-scope
 * `workspaceAgentProfileCatalog` and arrives through the seeded
 * `ISessionAgentProfileCatalogData` read view — this service never scans
 * the filesystem itself. Reads (`get` / `getDefault` / `list`) delegate to
 * the live seed, `ready` tracks the seed's readiness (a fatal explicit-file
 * error still propagates into session materialization), and change events
 * are forwarded with their source id. `reload()` no longer re-scans: it
 * awaits the seed and re-fires `catalog`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

import { ISessionAgentProfileCatalogData } from './agentProfileCatalogData';
import { ISessionAgentProfileCatalog } from './sessionAgentProfileCatalog';

export class SessionAgentProfileCatalogService
  extends Disposable
  implements ISessionAgentProfileCatalog
{
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(@ISessionAgentProfileCatalogData private readonly data: ISessionAgentProfileCatalogData) {
    super();
    this._register(this.data.onDidChange((sourceId) => this.onDidChangeEmitter.fire(sourceId)));
  }

  get ready(): Promise<void> {
    return this.data.ready;
  }

  get(name: string): AgentProfile | undefined {
    return this.data.get(name);
  }

  getDefault(): AgentProfile {
    return this.data.getDefault();
  }

  list(): readonly AgentProfile[] {
    return this.data.list();
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    this.onDidChangeEmitter.fire('catalog');
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentProfileCatalog,
  SessionAgentProfileCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionAgentProfileCatalog',
);
