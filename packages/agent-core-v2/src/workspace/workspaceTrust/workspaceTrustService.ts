import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { defineState } from '#/state/state';
import { IDefaultWorkspace } from '#/app/defaultWorkspace/defaultWorkspace';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

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
  private inner?: IWorkspaceTrustEntry;
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IWorkspaceTrustStore private readonly trustStore: IWorkspaceTrustStore,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
    @IDefaultWorkspace private readonly defaultWorkspace: IDefaultWorkspace,
  ) {
    super();
    this.states.contributeState(workspaceTrustTrustedKey);
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
    return this.inner?.isTrusted() ?? false;
  }

  async get(): Promise<boolean> {
    await this.ready;
    return this.inner!.get();
  }

  trust(): Promise<void> {
    return this.inner!.trust();
  }

  untrust(): Promise<void> {
    return this.inner!.untrust();
  }

  private async initialize(): Promise<void> {
    const trustRoot = (await this.defaultWorkspace.baseRootFor(this.workspace.cwd)) ?? this.workspace.cwd;
    const inner = this.trustStore.forRoot(trustRoot);
    this.inner = inner;
    this._register(inner.onDidChange((change) => {
      this.trusted = change.trusted;
      this.changeEmitter.fire(change);
    }));
    await inner.ready;
    this.trusted = inner.isPersistedTrusted();
  }
}
