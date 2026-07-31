/**
 * `sessionSkillCatalog` domain (L3) — `ISessionSkillCatalog` sink
 * implementation.
 *
 * The Session-scope business view over the workspace's merged skill catalog:
 * the discovery/merge/rescan work lives on the Workspace-scope
 * `workspaceSkillCatalog` and arrives through the seeded
 * `ISessionSkillCatalogData` read view — this service never scans the
 * filesystem itself. It re-folds the data snapshot on every seeded change
 * event (forwarding the source id) and merges session-local ad-hoc
 * contributions (`ISkillCatalogSink`) on top by priority. `reload()` no
 * longer re-scans: it re-folds the current seed and re-fires `catalog`.
 * The plain-data state (`contributions`, `merged`) is registered into
 * `sessionState` (`ISessionStateService`) and read/written through it.
 * Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionStateService } from '#/session/state/sessionState';

import { ISessionSkillCatalog, type ISkillCatalogSink } from './skillCatalog';
import { ISessionSkillCatalogData } from './skillCatalogData';

export const skillCatalogContributionsKey = defineState<
  Map<string, { readonly c: SkillContribution; readonly priority: number }>
>('sessionSkillCatalog.contributions', () => new Map());
export const skillCatalogMergedKey = defineState<InMemorySkillCatalog>(
  'sessionSkillCatalog.merged',
  () => new InMemorySkillCatalog(),
);

export class SessionSkillCatalogService
  extends Disposable
  implements ISessionSkillCatalog, ISkillCatalogSink
{
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @ISessionSkillCatalogData private readonly data: ISessionSkillCatalogData,
    @ISessionStateService private readonly states: ISessionStateService,
  ) {
    super();
    this.states.register(skillCatalogContributionsKey);
    this.states.register(skillCatalogMergedKey);
    this._register(
      this.data.onDidChange((sourceId) => {
        this.remerge();
        this.onDidChangeEmitter.fire(sourceId);
      }),
    );
    this.remerge();
    this.ready = this.data.ready.then(() => this.remerge());
  }

  private get contributions(): Map<
    string,
    { readonly c: SkillContribution; readonly priority: number }
  > {
    return this.states.get(skillCatalogContributionsKey);
  }

  private get merged(): InMemorySkillCatalog {
    return this.states.get(skillCatalogMergedKey);
  }

  private set merged(value: InMemorySkillCatalog) {
    this.states.set(skillCatalogMergedKey, value);
  }

  get catalog(): SkillCatalog {
    return this.merged;
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    this.remerge();
    this.onDidChangeEmitter.fire('catalog');
  }

  set(id: string, c: SkillContribution, { priority }: { readonly priority: number }): void {
    this.contributions.set(id, { c, priority });
    this.remerge();
    this.onDidChangeEmitter.fire(id);
  }

  remove(id: string): void {
    this.contributions.delete(id);
    this.remerge();
    this.onDidChangeEmitter.fire(id);
  }

  private remerge(): void {
    const m = new InMemorySkillCatalog();
    const base = this.data.catalog;
    for (const skill of base.listSkills()) m.register(skill, { replace: true });
    m.addRoots(base.getSkillRoots());
    m.recordSkipped(base.getSkippedByPolicy());
    const ordered = [...this.contributions.values()].toSorted((a, b) => a.priority - b.priority);
    for (const { c } of ordered) {
      for (const skill of c.skills) m.register(skill, { replace: true });
      m.addRoots(c.scannedRoots ?? []);
      m.recordSkipped(c.skipped ?? []);
    }
    this.merged = m;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSkillCatalog,
  SessionSkillCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
