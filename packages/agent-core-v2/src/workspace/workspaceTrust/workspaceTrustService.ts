import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { defineState } from '#/state/state';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt: number;
}

export const workspaceTrustTrustedKey = defineState<boolean>(
  'workspaceTrust.trusted',
  () => false,
);

export class WorkspaceTrustService extends Disposable implements IWorkspaceTrust {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly root: string;
  private readonly storeKey: string;
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
    this.storeKey = encodeWorkDirKey(workspace.cwd);
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
    await this.docs.set(TRUST_SCOPE, this.storeKey, {
      root: this.root,
      trustedAt: Date.now(),
    });
    this.trusted = true;
    this.changeEmitter.fire({ trusted: true });
  }

  async untrust(): Promise<void> {
    if (!this.trusted) return;
    await this.docs.delete(TRUST_SCOPE, this.storeKey);
    this.trusted = false;
    this.changeEmitter.fire({ trusted: false });
  }

  private async initialize(): Promise<void> {
    try {
      this.trusted = (await this.docs.get<TrustRecord>(TRUST_SCOPE, this.storeKey)) !== undefined;
    } catch {
      this.trusted = false;
    }
  }
}

