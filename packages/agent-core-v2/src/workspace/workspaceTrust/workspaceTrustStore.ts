import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { trustWorkspaceEnvTrusted } from './trustEnv';
import { deleteWorkspaceTrust, readWorkspaceTrust, writeWorkspaceTrust } from './trustRecord';
import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';

export interface IWorkspaceTrustEntry extends IWorkspaceTrust {
  isPersistedTrusted(): boolean;
}

export interface IWorkspaceTrustStore {
  readonly _serviceBrand: undefined;

  forRoot(root: string): IWorkspaceTrustEntry;
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
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    root: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly telemetry: ITelemetryService,
    bootstrap: IBootstrapService,
  ) {
    super();
    this.root = root;
    this.envTrusted = trustWorkspaceEnvTrusted((name) => bootstrap.getEnv(name));
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const recovering = this.initializationFailed;
    const initialization = readWorkspaceTrust(this.docs, this.root, this.telemetry).then((trusted) => {
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
    return this.envTrusted || this.trusted;
  }

  async get(): Promise<boolean> {
    await this.ready;
    return this.isTrusted();
  }

  trust(): Promise<void> {
    return this.mutate(true);
  }

  untrust(): Promise<void> {
    return this.mutate(false);
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
      this.changeEmitter.fire({ trusted });
      this.telemetry.track2('workspace_trust_changed', { trusted });
    });
    this.mutationTail = mutation;
    return mutation;
  }
}

export class WorkspaceTrustStore extends Disposable implements IWorkspaceTrustStore {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, IWorkspaceTrustEntry>();

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
  }

  forRoot(root: string): IWorkspaceTrustEntry {
    const key = canonicalWorkspaceRoot(root);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry = this._register(new WorkspaceTrustEntry(root, this.docs, this.telemetry, this.bootstrap));
    this.entries.set(key, entry);
    return entry;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceTrustStore,
  WorkspaceTrustStore,
  ScopeActivation.OnDemand,
  'workspaceTrustStore',
);
