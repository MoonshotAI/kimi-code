import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { DisposableStore } from '#/_base/di/lifecycle';
import { AsyncEmitter, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IEnvironmentService } from '#/app/environment/environment';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ENVIRONMENTS_SECTION } from '#/environment/configSection';
import { declarationFingerprint, loadProjectEnvironmentsSection, PROJECT_ENVIRONMENTS_FILE, resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { LOCAL_ENVIRONMENT_ID, type Environment } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { sectionEntries, type EnvironmentDeclarationSet, type EnvironmentsSection, type RemoteEnvironmentDeclaration } from '#/environment/remoteEnvironmentDeclaration';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { watchCandidates } from '#human/utils/watch';

import { IEnvironmentDeclarationService } from './environmentDeclaration';

interface ProjectSource {
  readonly context: IWorkspaceContext;
  readonly fs: IHostFileSystem;
  readonly trust: IWorkspaceTrust;
  section?: EnvironmentsSection;
  error?: Error;
  refresh?: Promise<void>;
  revision: number;
}

interface Candidate {
  readonly declaration: RemoteEnvironmentDeclaration;
  readonly source: string;
  readonly origin: string;
}

const NO_ABORT = new AbortController().signal;

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;
  private readonly projects = new Map<string, ProjectSource>();
  private readonly registrations = new Map<string, Environment>();
  private readonly winners = new Map<string, Candidate>();
  private readonly conflicts = new Map<string, Map<string, Error>>();
  private readonly registrationErrors = new Map<string, Error>();
  private user: EnvironmentDeclarationSet = { entries: [] };
  private userError?: unknown;
  private userRefresh?: Promise<void>;
  private userRevision = 0;
  private catalogKey?: string;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly subscriptions = new DisposableStore();
  private readonly changes = new AsyncEmitter<EnvironmentDeclarationSet & IWaitUntil>();
  readonly onDidChange = this.changes.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
    @IEnvironmentService private readonly environments: Pick<IEnvironmentService, 'current'>,
  ) {
    if (config.onDidSectionChange !== undefined) {
      this.subscriptions.add(config.onDidSectionChange((event) => {
        if (event.domain === ENVIRONMENTS_SECTION) this.scheduleRefresh();
      }));
    }
  }

  attachWorkspace(context: IWorkspaceContext, fs: IHostFileSystem, trust: IWorkspaceTrust): { dispose(): void } {
    if (this.projects.has(context.workspaceId)) throw new Error(`environment source already attached for ${context.workspaceId}`);
    const source: ProjectSource = { context, fs, trust, revision: 0 };
    this.projects.set(context.workspaceId, source);
    const subscriptions = new DisposableStore();
    this.subscriptions.add(subscriptions);
    subscriptions.add(trust.onDidChange(() => { this.scheduleRefresh(context.workspaceId); }));
    const watcher = subscriptions.add(watchCandidates(context.cwd, [join(context.cwd, PROJECT_ENVIRONMENTS_FILE)]));
    subscriptions.add(watcher.onDidChange(() => { this.scheduleRefresh(context.workspaceId); }));
    this.scheduleRefresh(context.workspaceId);
    return {
      dispose: () => {
        this.subscriptions.delete(subscriptions);
        if (this.projects.get(context.workspaceId) !== source) return;
        this.projects.delete(context.workspaceId);
        this.scheduleRefresh();
      },
    };
  }

  private scheduleRefresh(workspaceId?: string): void {
    if (this.disposed) return;
    if (workspaceId === undefined) this.userRevision += 1;
    else {
      const source = this.projects.get(workspaceId);
      if (source !== undefined) source.revision += 1;
    }
    void this.refresh(workspaceId).catch((error) => { this.log.warn('remote environment declaration reload failed', { error }); });
  }

  async catalog(): Promise<EnvironmentDeclarationSet> {
    await this.refresh(undefined, true);
    return { entries: [...this.winners.values()].map(({ declaration }) => declaration) };
  }

  async declarations(workspaceId?: string): Promise<EnvironmentDeclarationSet | undefined> {
    await this.refresh(workspaceId);
    const project = workspaceId === undefined ? undefined : this.projects.get(workspaceId);
    if (this.userError !== undefined && project?.section === undefined && project?.error === undefined) return undefined;
    const userEntries = this.userError === undefined ? this.user.entries : [];
    const entries = new Map(userEntries.filter(({ id }) => !this.conflicts.get('user')?.has(id)).map((entry) => [entry.id, entry]));
    if (project?.trust.isTrusted()) {
      for (const entry of sectionEntries(project.section)) {
        if (!this.conflicts.get(workspaceId!)?.has(entry.id)) entries.set(entry.id, { ...entry, source: 'project' });
      }
    }
    const projectDefault = project?.trust.isTrusted() ? project.section?.default : undefined;
    const defaultEntry = projectDefault === undefined ? undefined : entries.get(projectDefault);
    const userDefault = this.userError === undefined ? this.user.default : undefined;
    return {
      entries: [...entries.values()],
      default: projectDefault === undefined ? userDefault : defaultEntry?.entry.defaultCwd === undefined ? undefined : { environmentId: projectDefault, cwd: defaultEntry.entry.defaultCwd, source: 'project' },
      projectError: project?.error ?? (projectDefault === undefined ? undefined : this.conflicts.get(workspaceId!)?.get(projectDefault)) ?? (projectDefault === undefined && userDefault !== undefined ? this.conflicts.get('user')?.get(userDefault.environmentId) : undefined),
      trustRequired: project !== undefined && !project.trust.isTrusted() && (project.section?.default !== undefined || project.error !== undefined),
    };
  }

  isVisible(workspaceId: string, environmentId: string): boolean {
    try {
      this.assertAllowed(workspaceId, environmentId);
      return true;
    } catch {
      return false;
    }
  }

  assertAllowed(workspaceId: string, environmentId: string, project = false): void {
    if (environmentId === LOCAL_ENVIRONMENT_ID) return;
    const registrationError = this.registrationErrors.get(environmentId);
    if (registrationError !== undefined) throw registrationError;
    const source = this.projects.get(workspaceId);
    const declaresProject = source?.trust.isTrusted() && sectionEntries(source.section).some(({ id }) => id === environmentId);
    const conflict = this.conflicts.get(workspaceId)?.get(environmentId) ?? this.conflicts.get('user')?.get(environmentId);
    if (conflict !== undefined && !(declaresProject && !this.conflicts.get(workspaceId)?.has(environmentId))) throw conflict;
    if (source?.trust.isTrusted() && source.error !== undefined && (project || (this.isDeclared(environmentId) && !this.user.entries.some(({ id }) => id === environmentId)))) throw source.error;
    if (project && !declaresProject) {
      throw new EnvironmentError('environment.unavailable', `project environment "${environmentId}" requires its trusted declaration in ${PROJECT_ENVIRONMENTS_FILE}`);
    }
    if (declaresProject || this.user.entries.some(({ id }) => id === environmentId)) return;
    if (this.isDeclared(environmentId)) {
      throw new EnvironmentError('environment.unavailable', `environment "${environmentId}" is not authorized for this workspace`);
    }
  }

  reportRegistration(environmentId: string, error?: Error): void {
    if (error === undefined) this.registrationErrors.delete(environmentId);
    else {
      this.registrationErrors.set(environmentId, new Error2(ErrorCodes.CONFIG_INVALID, `environment "${environmentId}" could not be registered: ${error.message}`, { cause: error }));
      this.catalogKey = undefined;
    }
  }

  trackRegistration(environment: Environment): { dispose(): void } {
    const id = environment.identity.environmentId;
    this.registrations.set(id, environment);
    return { dispose: () => {
      if (this.registrations.get(id) === environment) this.registrations.delete(id);
    } };
  }

  isDeclared(environmentId: string): boolean {
    const registration = this.registrations.get(environmentId);
    return this.winners.has(environmentId) || (registration !== undefined && this.environments.current(environmentId) === registration);
  }

  async whenReady(workspaceId: string): Promise<void> {
    do {
      await Promise.all([this.userRefresh, this.projects.get(workspaceId)?.refresh]);
      await this.reconcile();
    } while (this.userRefresh !== undefined || this.projects.get(workspaceId)?.refresh !== undefined);
  }

  private async refresh(workspaceId?: string, all = false): Promise<void> {
    if (this.disposed) return;
    const sources = all ? [...this.projects.values()] : [this.projects.get(workspaceId ?? '')].filter((source) => source !== undefined);
    await Promise.all([this.refreshUser(), ...sources.map((source) => this.refreshProject(source))]);
    await this.reconcile();
  }

  private refreshUser(): Promise<void> {
    if (this.userRefresh !== undefined) return this.userRefresh;
    const run = (async () => {
      try {
        let revision: number;
        do {
          revision = this.userRevision;
          try {
            this.user = await resolveWorkspaceEnvironmentDeclarations(this.config);
            this.userError = undefined;
          } catch (error) {
            this.userError = error;
            this.log.warn('remote environment declaration resolution failed', { error });
          }
        } while (!this.disposed && revision !== this.userRevision);
      } finally {
        this.userRefresh = undefined;
      }
    })();
    this.userRefresh = run;
    return run;
  }

  private refreshProject(source: ProjectSource): Promise<void> {
    if (source.refresh !== undefined) return source.refresh;
    const run = (async () => {
      try {
        await source.trust.ready;
        let revision: number;
        do {
          revision = source.revision;
          try {
            source.section = await loadProjectEnvironmentsSection(source.fs, source.context.cwd);
            source.error = undefined;
          } catch (error) {
            source.section = undefined;
            source.error = error instanceof Error ? error : new Error(String(error));
            this.log.warn('project environment declaration resolution failed', { error });
          }
        } while (!this.disposed && this.projects.get(source.context.workspaceId) === source && revision !== source.revision);
      } finally {
        source.refresh = undefined;
      }
    })();
    source.refresh = run;
    return run;
  }

  private reconcile(): Promise<void> {
    const run = this.tail.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      const candidates = new Map<string, Candidate[]>();
      const add = (declaration: RemoteEnvironmentDeclaration, source: string, origin: string): void => {
        const bucket = candidates.get(declaration.id) ?? [];
        bucket.push({ declaration, source, origin });
        candidates.set(declaration.id, bucket);
      };
      for (const entry of this.user.entries) add(entry, 'user', 'config.toml [environments]');
      for (const [id, source] of this.projects) {
        if (!source.trust.isTrusted()) continue;
        for (const entry of sectionEntries(source.section)) {
          add({ ...entry, source: 'project' }, id, join(source.context.cwd, PROJECT_ENVIRONMENTS_FILE));
        }
      }
      this.conflicts.clear();
      for (const id of this.winners.keys()) if (!candidates.has(id)) this.winners.delete(id);
      for (const id of this.registrationErrors.keys()) if (!candidates.has(id)) this.registrationErrors.delete(id);
      for (const [id, bucket] of candidates) {
        const previous = this.winners.get(id);
        const winner = bucket.find((candidate) => previous !== undefined && declarationFingerprint(candidate.declaration.entry) === declarationFingerprint(previous.declaration.entry)) ?? bucket[0]!;
        this.winners.set(id, winner);
        for (const candidate of bucket) {
          if (declarationFingerprint(candidate.declaration.entry) === declarationFingerprint(winner.declaration.entry)) continue;
          const conflicts = this.conflicts.get(candidate.source) ?? new Map<string, Error>();
          conflicts.set(id, new Error2(ErrorCodes.CONFIG_INVALID, `environment "${id}" conflicts between ${candidate.origin} and ${winner.origin}; use distinct ids for different launchers`));
          this.conflicts.set(candidate.source, conflicts);
        }
      }
      const entries = [...this.winners.values()].map(({ declaration }) => declaration);
      const key = JSON.stringify(entries.toSorted((a, b) => a.id.localeCompare(b.id)));
      if (key === this.catalogKey) return;
      await this.changes.fireAsync({ entries }, NO_ABORT);
      this.catalogKey = this.registrationErrors.size === 0 ? key : undefined;
    });
    this.tail = run;
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.dispose();
    this.changes.dispose();
  }
}

registerScopedService(LifecycleScope.App, IEnvironmentDeclarationService, EnvironmentDeclarationService, ScopeActivation.OnScopeCreated, 'environmentDeclaration');
