/**
 * `sessionSkillCatalog` domain (L3) — `ISessionSkillCatalog` sink implementation.
 *
 * Dumb ordered-merge table: pulls the six eager `ISkillSource`s (builtin /
 * user / explicit / extra / workspace / plugin) and folds their contributions into an in-memory
 * catalog by priority, so higher-priority sources win name collisions. `ready`
 * resolves once all six have completed their first `load()`+merge; a source's
 * `onDidChange` (e.g. plugin reload) re-pulls just that source and re-merges,
 * firing `onDidChange`. `set`/`remove` (`ISkillCatalogSink`) let ad-hoc sources
 * push contributions. Bound at Session scope; the same instance is the
 * `ISessionSkillCatalog` read view.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { ISkillSource, SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { IUserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';

import { IPluginSkillSource } from './pluginSkillSource';
import { IExtraFileSkillSource } from './extraFileSkillSource';
import { IExplicitFileSkillSource } from './explicitFileSkillSource';
import { ISessionSkillCatalog, type ISkillCatalogSink } from './skillCatalog';
import { IWorkspaceFileSkillSource } from './workspaceFileSkillSource';

export class SessionSkillCatalogService
  extends Disposable
  implements ISessionSkillCatalog, ISkillCatalogSink
{
  declare readonly _serviceBrand: undefined;

  private readonly sources: readonly ISkillSource[];
  private readonly contributions = new Map<
    string,
    { readonly c: SkillContribution; readonly priority: number }
  >();
  private merged = new InMemorySkillCatalog();
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @IBuiltinSkillSource builtin: IBuiltinSkillSource,
    @IUserFileSkillSource user: IUserFileSkillSource,
    @IExplicitFileSkillSource explicit: IExplicitFileSkillSource,
    @IExtraFileSkillSource extra: IExtraFileSkillSource,
    @IWorkspaceFileSkillSource workspace: IWorkspaceFileSkillSource,
    @IPluginSkillSource plugin: IPluginSkillSource,
  ) {
    super();
    this.sources = [builtin, user, explicit, extra, workspace, plugin].toSorted((a, b) => a.priority - b.priority);
    for (const s of this.sources) {
      if (s.onDidChange) this._register(s.onDidChange(() => { void this.reloadSource(s.id); }));
    }
    this.ready = this.loadAll();
  }

  get catalog(): SkillCatalog {
    return this.merged;
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.loadAll();
    this.onDidChangeEmitter.fire();
  }

  set(id: string, c: SkillContribution, { priority }: { readonly priority: number }): void {
    this.contributions.set(id, { c, priority });
    this.remerge();
    this.onDidChangeEmitter.fire();
  }

  remove(id: string): void {
    this.contributions.delete(id);
    this.remerge();
    this.onDidChangeEmitter.fire();
  }

  private async loadAll(): Promise<void> {
    for (const s of this.sources) {
      const c = await s.load();
      this.contributions.set(s.id, { c, priority: s.priority });
    }
    this.remerge();
  }

  private async reloadSource(id: string): Promise<void> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    const c = await s.load();
    this.contributions.set(s.id, { c, priority: s.priority });
    this.remerge();
    this.onDidChangeEmitter.fire();
  }

  private remerge(): void {
    const m = new InMemorySkillCatalog();
    const ordered = [...this.contributions.values()].toSorted((a, b) => a.priority - b.priority);
    for (const { c } of ordered) for (const skill of c.skills) m.register(skill, { replace: true });
    this.merged = m;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSkillCatalog,
  SessionSkillCatalogService,
  InstantiationType.Delayed,
  'sessionSkillCatalog',
);
