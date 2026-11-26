import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { canonicalProjectRoot } from '#/_base/utils/paths';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { Project } from '#/app/project/project';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  WORKSPACE_TRUST_SECTION,
  projectTrustRequired,
} from './configSection';
import { trustWorkspaceEnvTrusted } from './trustEnv';
import { deleteProjectTrust, readProjectTrust, writeProjectTrust } from './trustRecord';
import { IProjectTrust, type ProjectTrustChange } from './projectTrust';

export interface IProjectTrustEntry extends IProjectTrust {
  isPersistedTrusted(): boolean;
  refresh(): Promise<boolean>;
}

export interface IProjectTrustStore {
  readonly _serviceBrand: undefined;

  forRoot(root: string): IProjectTrustEntry;
  forProject(project: Pick<Project, 'root' | 'additionalDirs'>): IProjectTrustEntry;
  carry(fromRoot: string, toRoot: string): Promise<void>;
}

export const IProjectTrustStore: ServiceIdentifier<IProjectTrustStore> =
  createDecorator<IProjectTrustStore>('workspaceTrustStore');

class ProjectTrustEntry extends Disposable implements IProjectTrustEntry {
  declare readonly _serviceBrand: undefined;

  private initialization?: Promise<void>;
  private initializationFailed = false;
  private readonly root: string;
  private readonly envTrusted: boolean;
  private trusted = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this._register(new Emitter<ProjectTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    root: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly telemetry: ITelemetryService,
    bootstrap: IBootstrapService,
    private readonly config: IConfigService,
  ) {
    super();
    this.root = root;
    this.envTrusted = trustWorkspaceEnvTrusted((name) => bootstrap.getEnv(name));
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const recovering = this.initializationFailed;
    const initialization = readProjectTrust(this.docs, this.root, this.telemetry).then((trusted) => {
      this.trusted = trusted;
      this.initializationFailed = false;
      if (recovering) this.changeEmitter.fire({ trusted });
    });
    this.initialization = initialization;
    void initialization.catch(() => {
      this.initializationFailed = true;
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  isPersistedTrusted(): boolean {
    return this.trusted;
  }

  isTrusted(): boolean {
    return !this.trustGateEnabled() || this.envTrusted || this.trusted;
  }

  async get(): Promise<boolean> {
    await this.config.ready;
    if (!this.trustGateEnabled()) return true;
    await this.ready;
    return this.isTrusted();
  }

  async refresh(): Promise<boolean> {
    await this.config.ready;
    if (!this.trustGateEnabled()) return true;
    await this.ready;
    const refresh = this.mutationTail.catch(() => {}).then(async () => {
      const trusted = await readProjectTrust(this.docs, this.root, this.telemetry);
      if (this.trusted === trusted) return;
      this.trusted = trusted;
      this.changeEmitter.fire({ trusted });
    });
    this.mutationTail = refresh;
    await refresh;
    return this.isTrusted();
  }

  onConfigChange(): void {
    if (!this.trustGateEnabled()) {
      this.changeEmitter.fire({ trusted: this.trusted });
      return;
    }
    void this.ready
      .catch(() => undefined)
      .then(() => this.changeEmitter.fire({ trusted: this.trusted }));
  }

  trust(): Promise<void> {
    return this.mutate(true);
  }

  untrust(): Promise<void> {
    return this.mutate(false);
  }

  private trustGateEnabled(): boolean {
    return projectTrustRequired(this.config);
  }

  private mutate(trusted: boolean): Promise<void> {
    const mutation = this.mutationTail.catch(() => {}).then(async () => {
      await this.ready;
      if (this.trusted === trusted) return;
      if (trusted) {
        await writeProjectTrust(this.docs, this.root, Date.now());
      } else {
        await deleteProjectTrust(this.docs, this.root);
      }
      this.trusted = trusted;
      this.changeEmitter.fire({ trusted });
      this.telemetry.track2('workspace_trust_changed', { trusted });
    });
    this.mutationTail = mutation;
    return mutation;
  }
}

class ProjectTrust implements IProjectTrustEntry {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly primary: IProjectTrustEntry,
    private readonly directories: readonly IProjectTrustEntry[],
  ) {}

  get ready(): Promise<void> {
    return this.primary.ready;
  }

  get onDidChange(): Event<ProjectTrustChange> {
    return this.primary.onDidChange;
  }

  isPersistedTrusted(): boolean {
    return this.primary.isPersistedTrusted();
  }

  isTrusted(): boolean {
    return this.primary.isTrusted();
  }

  get(): Promise<boolean> {
    return this.primary.get();
  }

  refresh(): Promise<boolean> {
    return this.primary.refresh();
  }

  trust(): Promise<void> {
    return this.primary.trust();
  }

  async untrust(): Promise<void> {
    await Promise.all(this.directories.map((entry) => entry.untrust()));
  }
}

export class ProjectTrustStore extends Disposable implements IProjectTrustStore {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, ProjectTrustEntry>();

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this._register(this.config.onDidSectionChange((event) => {
      if (event.domain !== WORKSPACE_TRUST_SECTION) return;
      for (const entry of this.entries.values()) entry.onConfigChange();
    }));
  }

  forRoot(root: string): IProjectTrustEntry {
    const key = canonicalProjectRoot(root);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry = this._register(new ProjectTrustEntry(root, this.docs, this.telemetry, this.bootstrap, this.config));
    this.entries.set(key, entry);
    return entry;
  }

  forProject(project: Pick<Project, 'root' | 'additionalDirs'>): IProjectTrustEntry {
    const directories = new Set([project.root, ...project.additionalDirs].map((dir) => this.forRoot(dir)));
    return new ProjectTrust(this.forRoot(project.root), [...directories]);
  }

  async carry(fromRoot: string, toRoot: string): Promise<void> {
    if (!(await readProjectTrust(this.docs, fromRoot, this.telemetry))) return;
    await this.forRoot(toRoot).trust();
  }
}

registerScopedService(
  LifecycleScope.App,
  IProjectTrustStore,
  ProjectTrustStore,
  ScopeActivation.OnDemand,
  'workspaceTrustStore',
);
