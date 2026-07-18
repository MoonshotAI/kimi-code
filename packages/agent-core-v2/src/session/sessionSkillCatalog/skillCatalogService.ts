/**
 * `sessionSkillCatalog` domain (L3) — `ISessionSkillCatalog` sink implementation.
 *
 * Merges builtin, user, explicit, extra, workspace, and plugin skill sources
 * by priority, serializing refreshes for each source. Exposes the merged read
 * view and accepts ad-hoc contributions through `ISkillCatalogSink`. Bound at
 * Session scope.
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
  private readonly sourceLoadTails = new Map<ISkillSource, Promise<void>>();
  private merged = new InMemorySkillCatalog();
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

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

  private async loadAll(): Promise<void> {
    for (const s of this.sources) {
      await this.loadSource(s);
    }
    this.remerge();
  }

  private async reloadSource(id: string): Promise<void> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    await this.loadSource(s, true);
  }

  private loadSource(source: ISkillSource, fireChange = false): Promise<void> {
    const previous = this.sourceLoadTails.get(source) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const contribution = await source.load();
      this.contributions.set(source.id, { c: contribution, priority: source.priority });
      if (fireChange) {
        this.remerge();
        this.onDidChangeEmitter.fire(source.id);
      }
    });
    this.sourceLoadTails.set(source, current);
    const clear = () => {
      if (this.sourceLoadTails.get(source) === current) {
        this.sourceLoadTails.delete(source);
      }
    };
    void current.then(clear, clear);
    return current;
  }

  private remerge(): void {
    const m = new InMemorySkillCatalog();
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
  InstantiationType.Eager,
  'sessionSkillCatalog',
);
