import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { defineState } from '#/state/state';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { workspaceTrustRequired } from './configSection';
import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';
import {
  IWorkspaceTrustStore,
  type IWorkspaceTrustEntry,
} from './workspaceTrustStore';

export { TRUST_WORKSPACE_ENV, trustWorkspaceEnvTrusted } from './trustEnv';

export const workspaceTrustTrustedKey = defineState<boolean>(
  'workspaceTrust.trusted',
  () => false,
);

export class WorkspaceTrustService extends Disposable implements IWorkspaceTrust {
  declare readonly _serviceBrand: undefined;

  private initialization?: Promise<void>;
  private inner: IWorkspaceTrustEntry;
  private innerSubscription?: { dispose(): void };
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext private readonly context: IWorkspaceContext,
    @IWorkspaceTrustStore private readonly trustStore: IWorkspaceTrustStore,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.states.contributeState(workspaceTrustTrustedKey);
    this.inner = this.projectTrust();
    this.subscribe(this.inner);
    this._register({ dispose: () => this.innerSubscription?.dispose() });
    if (this.context.onDidChangeProject !== undefined) {
      this._register(this.context.onDidChangeProject(() => this.rebindTrust()));
    }
  }

  private projectTrust(): IWorkspaceTrustEntry {
    const project = this.context.meta;
    return this.trustStore.forRoots([project.root, ...(project.additionalDirs ?? [])]);
  }

  private subscribe(inner: IWorkspaceTrustEntry): void {
    this.innerSubscription?.dispose();
    this.innerSubscription = inner.onDidChange((change) => {
      this.trusted = change.trusted;
      this.changeEmitter.fire(change);
    });
  }

  private rebindTrust(): void {
    const next = this.projectTrust();
    if (this.inner === next) return;
    this.inner = next;
    this.subscribe(next);
    this.initialization = undefined;
    const previous = this.trusted;
    void this.ready.then(() => {
      if (this.inner === next && previous !== this.trusted) this.changeEmitter.fire({ trusted: this.trusted });
    }).catch(() => {});
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const initialization = this.initialize();
    this.initialization = initialization;
    void initialization.catch(() => {
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  private get trusted(): boolean {
    return this.states.get(workspaceTrustTrustedKey);
  }

  private set trusted(value: boolean) {
    this.states.set(workspaceTrustTrustedKey, value);
  }

  isTrusted(): boolean {
    return this.inner.isTrusted();
  }

  async get(): Promise<boolean> {
    await this.config.ready;
    if (!workspaceTrustRequired(this.config)) return true;
    await this.ready;
    return this.inner.refresh();
  }

  trust(): Promise<void> {
    return this.inner.trust();
  }

  untrust(): Promise<void> {
    return this.inner.untrust();
  }

  private async initialize(): Promise<void> {
    const inner = this.inner;
    await inner.ready;
    if (this.inner === inner) this.trusted = inner.isPersistedTrusted();
  }
}
