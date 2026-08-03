/**
 * `workspaceSkillCatalog` domain — `IWorkspaceSkillCatalog`
 * implementation.
 *
 * Merges builtin, user, explicit, extra, workspace-root, and plugin skill
 * sources by priority ONCE per handler, serializing refreshes for each
 * source; afterwards a source's `onDidChange` (fs watch / config section /
 * plugin reload) re-scans that source alone and re-fires the merged change
 * event — no full rescan ever leaves the build-time load. Filters
 * contributions by disabled source and excluded name through `config` after
 * discovery so the policy applies uniformly to every source, including
 * extra_skill_dirs. Registers plain-data state into `workspaceState` and
 * provides a live read view through `ISessionSkillCatalogData`. Bound at
 * Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IConfigService } from '#/app/config/config';
import { IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import {
  EXCLUDE_SKILL_NAMES_SECTION,
  type ExcludeSkillNamesConfig,
  SKILL_SOURCES_SECTION,
  type SkillSourcesConfig,
} from '#/app/skillCatalog/configSection';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { ISkillSource, SkillContribution } from '#/app/skillCatalog/skillSource';
import { normalizeSkillName, type SkillCatalog } from '#/app/skillCatalog/types';
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
    @IConfigService private readonly config: IConfigService,
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
    this._register(
      this.config.onDidSectionChange((event) => {
        if (
          event.domain === SKILL_SOURCES_SECTION ||
          event.domain === EXCLUDE_SKILL_NAMES_SECTION
        ) {
          this.remerge();
          this.onDidChangeEmitter.fire('config');
        }
      }),
    );
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
    const disabledSources = this.disabledSourceIds();
    const excludedNames = this.excludedSkillNames();
    const ordered = [...this.contributions.entries()].toSorted(([, a], [, b]) => a.priority - b.priority);
    for (const [sourceId, { c }] of ordered) {
      if (disabledSources.has(sourceId)) continue;
      for (const skill of c.skills) {
        if (excludedNames.has(normalizeSkillName(skill.name))) continue;
        m.register(skill, { replace: true });
      }
      m.addRoots(c.scannedRoots ?? []);
      m.recordSkipped(c.skipped ?? []);
    }
    this.merged = m;
  }

  private disabledSourceIds(): Set<string> {
    const sources = this.config.get<SkillSourcesConfig>(SKILL_SOURCES_SECTION) ?? {};
    return new Set(
      Object.entries(sources)
        .filter(([, enabled]) => enabled === false)
        .map(([id]) => id),
    );
  }

  private excludedSkillNames(): Set<string> {
    const names = this.config.get<ExcludeSkillNamesConfig>(EXCLUDE_SKILL_NAMES_SECTION) ?? [];
    return new Set(names.map((name) => normalizeSkillName(name)));
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceSkillCatalog,
  WorkspaceSkillCatalogService,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
