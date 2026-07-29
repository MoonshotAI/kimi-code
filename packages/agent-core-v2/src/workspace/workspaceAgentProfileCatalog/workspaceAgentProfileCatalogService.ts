/**
 * `workspaceAgentProfileCatalog` domain (L3) — `IWorkspaceAgentProfileCatalog`
 * implementation.
 *
 * Merges the builtin (code-contribution) App catalog with the file-backed
 * sources (user / extra / project / explicit) by priority ONCE per handler,
 * requiring an explicit opt-in before a file replaces a same-name builtin,
 * and serializing refreshes per source; afterwards a source's `onDidChange`
 * (fs watch / config section) re-scans that source alone — no full rescan
 * ever leaves the build-time load. A rejecting `fatal` source (an invalid
 * `--agent-file`) propagates into `ready` so session materialization fails
 * fast; a rejecting non-fatal source (a transient fs error inside a
 * directory source) degrades to a warning and keeps any previously loaded
 * contribution, so directory problems never poison the handler. `ready`
 * tracks the most recent load pass: `reload()` replaces it, so a fatal
 * failure does not wedge the catalog once the underlying problem is fixed,
 * and `loadAll` merges whatever loaded even when a fatal source rejects
 * mid-pass. The swallowed handler on `ready` keeps an un-awaited rejection
 * from crashing the process, and event-driven reloads get the same warning
 * treatment. The merged view is shared by every session of the handler
 * through the `ISessionAgentProfileCatalogData` seed (`sessionData()`), a
 * live read view over this service. Bound at Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isError2 } from '#/_base/errors/errors';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentProfileCatalogService,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type {
  AgentProfileContribution,
  IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import type { ISessionAgentProfileCatalogData } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogData';

import { IExplicitFileAgentSource } from './explicitFileAgentSource';
import { IExtraFileAgentSource } from './extraFileAgentSource';
import { IProjectFileAgentSource } from './projectFileAgentSource';
import { IWorkspaceAgentProfileCatalog } from './workspaceAgentProfileCatalog';

export class WorkspaceAgentProfileCatalogService
  extends Disposable
  implements IWorkspaceAgentProfileCatalog
{
  declare readonly _serviceBrand: undefined;

  private readonly sources: readonly IAgentProfileSource[];
  private readonly contributions = new Map<
    string,
    { readonly c: AgentProfileContribution; readonly priority: number }
  >();
  private merged = new Map<string, AgentProfile>();
  private readonly sourceLoadTails = new Map<IAgentProfileSource, Promise<void>>();
  private readyPromise: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @IAgentProfileCatalogService private readonly builtin: IAgentProfileCatalogService,
    @IUserFileAgentSource user: IUserFileAgentSource,
    @IExtraFileAgentSource extra: IExtraFileAgentSource,
    @IProjectFileAgentSource project: IProjectFileAgentSource,
    @IExplicitFileAgentSource explicit: IExplicitFileAgentSource,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.sources = [user, extra, project, explicit].toSorted((a, b) => a.priority - b.priority);
    for (const s of this.sources) {
      if (s.onDidChange) {
        this._register(
          s.onDidChange(() => {
            void this.reloadSource(s.id).catch((error) => {
              this.log.warn(`agent profile source "${s.id}" reload failed: ${String(error)}`);
            });
          }),
        );
      }
    }
    this.remerge();
    this.readyPromise = this.loadAll();
    void this.readyPromise.catch(() => undefined);
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get(name: string): AgentProfile | undefined {
    return this.merged.get(name);
  }

  getDefault(): AgentProfile {
    const profile = this.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new Error(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly AgentProfile[] {
    return [...this.merged.values()];
  }

  async reload(): Promise<void> {
    this.readyPromise = this.loadAll();
    void this.readyPromise.catch(() => undefined);
    await this.readyPromise;
    this.onDidChangeEmitter.fire('catalog');
  }

  async load(): Promise<void> {
    await this.ready;
  }

  sessionData(): ISessionAgentProfileCatalogData {
    const currentReady = (): Promise<void> => this.ready;
    const getProfile = (name: string): AgentProfile | undefined => this.get(name);
    const getDefaultProfile = (): AgentProfile => this.getDefault();
    const listProfiles = (): readonly AgentProfile[] => this.list();
    return {
      _serviceBrand: undefined,
      onDidChange: this.onDidChange,
      get ready() {
        return currentReady();
      },
      get: (name) => getProfile(name),
      getDefault: () => getDefaultProfile(),
      list: () => listProfiles(),
    };
  }

  private async loadAll(): Promise<void> {
    try {
      for (const s of this.sources) {
        await this.loadSource(s);
      }
    } finally {
      this.remerge();
    }
  }

  private async reloadSource(id: string): Promise<void> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    await this.loadSource(s, true);
  }

  private loadSource(source: IAgentProfileSource, fireChange = false): Promise<void> {
    const previous = this.sourceLoadTails.get(source) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        let contribution: AgentProfileContribution;
        try {
          contribution = await source.load();
        } catch (error) {
          if (source.fatal) throw error;
          const at = isError2(error) ? error.details?.['path'] : undefined;
          this.log.warn(
            `agent profile source "${source.id}" load failed: ${String(error)}${typeof at === 'string' ? ` [${at}]` : ''}`,
          );
          return;
        }
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
    const m = new Map<string, AgentProfile>();
    for (const profile of this.builtin.list()) {
      m.set(profile.name, profile);
    }
    const fileProfiles = new Map<string, AgentProfile[]>();
    const ordered = [...this.contributions.values()].toSorted((a, b) => b.priority - a.priority);
    for (const { c } of ordered) {
      const sourceProfiles = new Map<string, AgentProfile>();
      for (const profile of c.profiles) sourceProfiles.set(profile.name, profile);
      for (const profile of sourceProfiles.values()) {
        const candidates = fileProfiles.get(profile.name) ?? [];
        candidates.push(profile);
        fileProfiles.set(profile.name, candidates);
      }
    }
    for (const candidates of fileProfiles.values()) {
      for (const profile of candidates) {
        if (m.has(profile.name) && profile.override !== true) {
          this.log.warn(
            `agent file profile "${profile.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
          );
          continue;
        }
        m.set(profile.name, profile);
        break;
      }
    }
    this.merged = m;
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceAgentProfileCatalog,
  WorkspaceAgentProfileCatalogService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileCatalog',
);
