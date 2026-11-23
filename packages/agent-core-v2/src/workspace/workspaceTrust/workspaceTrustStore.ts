import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { WORKTREE_FLAG_ID } from '#/app/worktree/worktree';
import { resolveWorktreeCheckout } from '#/app/worktree/worktreeCheckout';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  WORKSPACE_TRUST_SECTION,
  workspaceTrustRequired,
} from './configSection';
import { trustWorkspaceEnvTrusted } from './trustEnv';
import { deleteWorkspaceTrust, readWorkspaceTrust, writeWorkspaceTrust } from './trustRecord';
import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';

export interface IWorkspaceTrustEntry extends IWorkspaceTrust {
  isPersistedTrusted(): boolean;
  refresh(): Promise<boolean>;
}

export interface IWorkspaceTrustStore {
  readonly _serviceBrand: undefined;

  forRoot(root: string): IWorkspaceTrustEntry;
  forRoots(roots: readonly string[]): IWorkspaceTrustEntry;
}

export const IWorkspaceTrustStore: ServiceIdentifier<IWorkspaceTrustStore> =
  createDecorator<IWorkspaceTrustStore>('workspaceTrustStore');

class WorkspaceTrustEntry extends Disposable implements IWorkspaceTrustEntry {
  declare readonly _serviceBrand: undefined;

  private initialization?: Promise<void>;
  private initializationFailed = false;
  private readonly root: string;
  private readonly envTrusted: boolean;
  private trusted = false;
  private inherited?: IWorkspaceTrustEntry;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    root: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly telemetry: ITelemetryService,
    bootstrap: IBootstrapService,
    private readonly config: IConfigService,
    private readonly inheritFrom: (root: string) => Promise<IWorkspaceTrustEntry | undefined>,
  ) {
    super();
    this.root = root;
    this.envTrusted = trustWorkspaceEnvTrusted((name) => bootstrap.getEnv(name));
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const recovering = this.initializationFailed;
    const initialization = Promise.all([
      readWorkspaceTrust(this.docs, this.root, this.telemetry),
      this.resolveInherited(),
    ]).then(([trusted]) => {
      this.trusted = trusted;
      this.initializationFailed = false;
      if (recovering) this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
    });
    this.initialization = initialization;
    void initialization.catch(() => {
      this.initializationFailed = true;
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  isPersistedTrusted(): boolean {
    return this.trusted || (this.inherited?.isPersistedTrusted() ?? false);
  }

  isTrusted(): boolean {
    return !this.trustGateEnabled() || this.envTrusted || this.isPersistedTrusted();
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
      const trusted = await readWorkspaceTrust(this.docs, this.root, this.telemetry);
      if (this.trusted === trusted) return;
      this.trusted = trusted;
      this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
    });
    this.mutationTail = refresh;
    await refresh;
    await this.inherited?.refresh();
    return this.isTrusted();
  }

  onConfigChange(): void {
    if (!this.trustGateEnabled()) {
      this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
      return;
    }
    void this.ready
      .catch(() => undefined)
      .then(() => this.changeEmitter.fire({ trusted: this.isPersistedTrusted() }));
  }

  trust(): Promise<void> {
    return this.mutate(true);
  }

  untrust(): Promise<void> {
    return this.mutate(false);
  }

  private trustGateEnabled(): boolean {
    return workspaceTrustRequired(this.config);
  }

  private async resolveInherited(): Promise<void> {
    if (this.inherited !== undefined) return;
    const inherited = await this.inheritFrom(this.root);
    if (inherited === undefined || this.inherited !== undefined) return;
    await inherited.ready;
    this.inherited = inherited;
    this._register(inherited.onDidChange(() => {
      this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
    }));
  }

  private mutate(trusted: boolean): Promise<void> {
    const mutation = this.mutationTail.catch(() => {}).then(async () => {
      await this.ready;
      if (this.trusted === trusted) return;
      if (trusted) {
        await writeWorkspaceTrust(this.docs, this.root, Date.now());
      } else {
        await deleteWorkspaceTrust(this.docs, this.root);
      }
      this.trusted = trusted;
      this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
      this.telemetry.track2('workspace_trust_changed', { trusted });
    });
    this.mutationTail = mutation;
    return mutation;
  }
}

class WorkspaceTrustGroup extends Disposable implements IWorkspaceTrustEntry {
  declare readonly _serviceBrand: undefined;

  private readonly primary: IWorkspaceTrustEntry;
  private readonly entries: readonly IWorkspaceTrustEntry[];
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;
  private initialization?: Promise<void>;

  constructor(
    roots: readonly string[],
    forRoot: (root: string) => IWorkspaceTrustEntry,
  ) {
    super();
    const seen = new Set<string>();
    const entries: IWorkspaceTrustEntry[] = [];
    for (const root of roots) {
      const key = canonicalWorkspaceRoot(root);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = forRoot(root);
      entries.push(entry);
      this._register(entry.onDidChange(() => {
        this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
      }));
    }
    const primary = entries[0];
    if (primary === undefined) throw new Error('workspace trust requires a primary root');
    this.primary = primary;
    this.entries = entries;
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const initialization = Promise.all(this.entries.map((entry) => entry.ready)).then(() => {});
    this.initialization = initialization;
    void initialization.catch(() => {
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  isPersistedTrusted(): boolean {
    return this.entries.some((entry) => entry.isPersistedTrusted());
  }

  isTrusted(): boolean {
    return this.entries.some((entry) => entry.isTrusted());
  }

  async get(): Promise<boolean> {
    return (await Promise.all(this.entries.map((entry) => entry.get()))).some(Boolean);
  }

  async refresh(): Promise<boolean> {
    await Promise.all(this.entries.map((entry) => entry.refresh()));
    return this.isTrusted();
  }

  trust(): Promise<void> {
    return this.primary.trust();
  }

  async untrust(): Promise<void> {
    await Promise.all(this.entries.map((entry) => entry.untrust()));
  }
}

export class WorkspaceTrustStore extends Disposable implements IWorkspaceTrustStore {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, WorkspaceTrustEntry>();
  private readonly groups = new Map<string, WorkspaceTrustGroup>();

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
    this._register(this.config.onDidSectionChange((event) => {
      if (event.domain !== WORKSPACE_TRUST_SECTION) return;
      for (const entry of this.entries.values()) entry.onConfigChange();
    }));
  }

  forRoot(root: string): IWorkspaceTrustEntry {
    const key = canonicalWorkspaceRoot(root);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry = this._register(new WorkspaceTrustEntry(
      root,
      this.docs,
      this.telemetry,
      this.bootstrap,
      this.config,
      (child) => this.mainCheckoutEntry(child),
    ));
    this.entries.set(key, entry);
    return entry;
  }

  private async mainCheckoutEntry(root: string): Promise<IWorkspaceTrustEntry | undefined> {
    if (!this.flags.enabled(WORKTREE_FLAG_ID)) return undefined;
    const checkout = await resolveWorktreeCheckout(this.hostFs, this.bootstrap.homeDir, root);
    if (checkout === undefined || checkout.kind === 'main') return undefined;
    return this.forRoot(checkout.repoRoot);
  }

  forRoots(roots: readonly string[]): IWorkspaceTrustEntry {
    const primary = roots[0];
    if (primary === undefined) throw new Error('workspace trust requires a primary root');
    const key = [
      canonicalWorkspaceRoot(primary),
      ...new Set(roots.map((root) => canonicalWorkspaceRoot(root)).toSorted()),
    ].join('\0');
    const existing = this.groups.get(key);
    if (existing !== undefined) return existing;
    const group = this._register(new WorkspaceTrustGroup(roots, (root) => this.forRoot(root)));
    this.groups.set(key, group);
    return group;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceTrustStore,
  WorkspaceTrustStore,
  ScopeActivation.OnDemand,
  'workspaceTrustStore',
);
