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
  private readonly inner: IWorkspaceTrustEntry;
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceTrustStore trustStore: IWorkspaceTrustStore,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.states.contributeState(workspaceTrustTrustedKey);
    this.inner = trustStore.forRoot(workspace.cwd);
    this._register(this.inner.onDidChange((change) => {
      this.trusted = change.trusted;
      this.changeEmitter.fire(change);
    }));
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
    return this.inner.get();
  }

  trust(): Promise<void> {
    return this.inner.trust();
  }

  untrust(): Promise<void> {
    return this.inner.untrust();
  }

  private async initialize(): Promise<void> {
    await this.inner.ready;
    this.trusted = this.inner.isPersistedTrusted();
  }
}
