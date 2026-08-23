import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { defineState } from '#/state/state';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';
import { deleteWorkspaceTrust, readWorkspaceTrust, writeWorkspaceTrust } from './trustRecord';

export const workspaceTrustTrustedKey = defineState<boolean>(
  'workspaceTrust.trusted',
  () => false,
);

export class WorkspaceTrustService extends Disposable implements IWorkspaceTrust {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly root: string;
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
  ) {
    super();
    this.states.contributeState(workspaceTrustTrustedKey);
    this.root = workspace.cwd;
    this.ready = this.initialize();
  }

  private get trusted(): boolean {
    return this.states.get(workspaceTrustTrustedKey);
  }

  private set trusted(value: boolean) {
    this.states.set(workspaceTrustTrustedKey, value);
  }

  isTrusted(): boolean {
    return this.trusted;
  }

  async get(): Promise<boolean> {
    await this.ready;
    return this.trusted;
  }

  async trust(): Promise<void> {
    if (this.trusted) return;
    await writeWorkspaceTrust(this.docs, this.root, Date.now());
    this.trusted = true;
    this.changeEmitter.fire({ trusted: true });
  }

  async untrust(): Promise<void> {
    if (!this.trusted) return;
    await deleteWorkspaceTrust(this.docs, this.root);
    this.trusted = false;
    this.changeEmitter.fire({ trusted: false });
  }

  private async initialize(): Promise<void> {
    this.trusted = await readWorkspaceTrust(this.docs, this.root);
  }
}
