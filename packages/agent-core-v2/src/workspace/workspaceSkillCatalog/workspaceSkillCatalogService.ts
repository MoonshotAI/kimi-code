/**
 * `workspaceSkillCatalog` domain (L3) — `IWorkspaceSkillCatalog`
 * implementation.
 *
 * Merges builtin, user, explicit, extra, workspace-root, and plugin skill
 * sources by priority ONCE per handler, serializing refreshes for each
 * source; afterwards a source's `onDidChange` (fs watch / config section /
 * plugin reload) re-scans that source alone and re-fires the merged change
 * event — no full rescan ever leaves the build-time load. The merged view is
 * shared by every session of the handler through the
 * `ISessionSkillCatalogData` seed (`sessionData()`), a live read view over
 * this service. The plain-data state (`contributions`, `merged`) is
 * registered into `workspaceState` (`IWorkspaceStateService`) and
 * read/written through it. Bound at Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { ISkillSource, SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { IUserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import type { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';

import { IExplicitFileSkillSource } from './explicitFileSkillSource';
import { IExtraFileSkillSource } from './extraFileSkillSource';
import { IPluginSkillSource } from './pluginSkillSource';
import { IWorkspaceRootSkillSource } from './rootFileSkillSource';
import { IWorkspaceSkillCatalog } from './workspaceSkillCatalog';

export const workspaceSkillCatalogContributionsKey = defineState<
  Map<string, { readonly c: SkillContribution; readonly priority: number }>
>('workspaceSkillCatalog.contributions', () => new Map());
export const workspaceSkillCatalogMergedKey = defineState<InMemorySkillCatalog>(
  'workspaceSkillCatalog.merged',
  () => new InMemorySkillCatalog(),
);

export class WorkspaceSkillCatalogService extends Disposable implements IWorkspaceSkillCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly sources: readonly ISkillSource[];
  private readonly sourceLoadTails = new Map<ISkillSource, Promise<void>>();
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @IBuiltinSkillSource builtin: IBuiltinSkillSource,
    @IUserFileSkillSource user: IUserFileSkillSource,
    @IExplicitFileSkillSource explicit: IExplicitFileSkillSource,
    @IExtraFileSkillSource extra: IExtraFileSkillSource,
    @IWorkspaceRootSkillSource workspace: IWorkspaceRootSkillSource,
    @IPluginSkillSource plugin: IPluginSkillSource,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
  ) {
    super();
    this.states.register(workspaceSkillCatalogContributionsKey);
    this.states.register(workspaceSkillCatalogMergedKey);
    this.sources = [builtin, user, explicit, extra, workspace, plugin].toSorted(
      (a, b) => a.priority - b.priority,
    );
    for (const s of this.sources) {
      if (s.onDidChange)
        this._register(
          s.onDidChange(() => {
            void this.reloadSource(s.id);
          }),
        );
    }
    this.ready = this.loadAll();
  }

  private get contributions(): Map<
    string,
    { readonly c: SkillContribution; readonly priority: number }
  > {
    return this.states.get(workspaceSkillCatalogContributionsKey);
  }

  private get merged(): InMemorySkillCatalog {
    return this.states.get(workspaceSkillCatalogMergedKey);
  }

  private set merged(value: InMemorySkillCatalog) {
    this.states.set(workspaceSkillCatalogMergedKey, value);
  }

  get catalog(): SkillCatalog {
    return this.merged;
  }

  async reload(): Promise<void> {
    await this.loadAll();
    this.onDidChangeEmitter.fire('catalog');
  }

  async load(): Promise<void> {
    await this.ready;
  }

  sessionData(): ISessionSkillCatalogData {
    const currentCatalog = (): SkillCatalog => this.merged;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get catalog() {
        return currentCatalog();
      },
    };
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
  LifecycleScope.Workspace,
  IWorkspaceSkillCatalog,
  WorkspaceSkillCatalogService,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
