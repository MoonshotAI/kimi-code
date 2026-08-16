/**
 * `workspaceTrust` domain — `IWorkspaceTrust` implementation.
 *
 * Persists the trust marker through the `persistence` domain's
 * `IAtomicDocumentStore` under the `workspace-trust` scope, one document per
 * workspace keyed by `encodeWorkDirKey(root)`, with the raw root kept in the
 * value for inspection. The nearest document for this root or an ancestor
 * decides trust; legacy documents without `trusted` remain trusted. `trust()`
 * writes an allow record and `untrust()` writes a deny record for this root.
 * The record lives under the kimi home,
 * never inside the workspace, so a checked-out tree cannot pre-trust
 * itself. The flag is read through `ready`, watches every ancestor record, and
 * every later mutation goes through this service. A read failure resolves to
 * untrusted. The plain-data state (`trusted`) is registered into
 * `workspaceState` (`IWorkspaceStateService`) and read/written through it.
 * Bound at Workspace scope.
 */

import { dirname, normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { defineState } from '#/_base/state/stateRegistry';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceTrust, type WorkspaceTrustChange } from './workspaceTrust';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trusted?: boolean;
  readonly trustedAt?: number;
  readonly untrustedAt?: number;
}

export const workspaceTrustTrustedKey = defineState<boolean>(
  'workspaceTrust.trusted',
  () => false,
);

// NOTE: stays Disposable — its own 'get' collides with the Fiber
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
    this.states.register(workspaceTrustTrustedKey);
    this.root = workspace.cwd;
    this.storeKey = encodeWorkDirKey(workspace.cwd);
    this.watchTrustRecords();
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
      trusted: true,
      trustedAt: Date.now(),
    });
    this.updateTrusted(true);
  }

  async untrust(): Promise<void> {
    if (!this.trusted) return;
    await this.docs.set(TRUST_SCOPE, this.storeKey, {
      root: this.root,
      trusted: false,
      untrustedAt: Date.now(),
    });
    this.updateTrusted(false);
  }

  private async initialize(): Promise<void> {
    try {
      this.trusted = await this.readTrusted();
    } catch {
      this.trusted = false;
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.updateTrusted(await this.readTrusted());
    } catch {
      this.updateTrusted(false);
    }
  }

  private async readTrusted(): Promise<boolean> {
    for (const key of this.trustRecordKeys()) {
      const record = await this.docs.get<TrustRecord>(TRUST_SCOPE, key);
      if (record !== undefined) return record.trusted !== false;
    }
    return false;
  }

  private watchTrustRecords(): void {
    for (const key of this.trustRecordKeys()) {
      this._register(
        this.docs.watch(TRUST_SCOPE, key)(() => {
          void this.refresh();
        }),
      );
    }
  }

  private trustRecordKeys(): readonly string[] {
    const keys = [this.storeKey];
    let current = dirname(normalize(this.root));
    while (true) {
      keys.push(encodeWorkDirKey(current));
      const parent = dirname(current);
      if (parent === current) return keys;
      current = parent;
    }
  }

  private updateTrusted(value: boolean): void {
    if (this.trusted === value) return;
    this.trusted = value;
    this.changeEmitter.fire({ trusted: value });
  }
}

