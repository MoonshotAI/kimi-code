import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { defineState } from '#/state/state';
import { IProjectStateService } from '#/project/state/projectState';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';

import { projectTrustRequired } from './configSection';
import { IProjectTrust, type ProjectTrustChange } from './projectTrust';
import {
  IProjectTrustStore,
  type IProjectTrustEntry,
} from './projectTrustStore';

export { TRUST_WORKSPACE_ENV, trustWorkspaceEnvTrusted } from './trustEnv';

export const projectTrustTrustedKey = defineState<boolean>(
  'workspaceTrust.trusted',
  () => false,
);

export class ProjectTrustService extends Disposable implements IProjectTrust {
  declare readonly _serviceBrand: undefined;

  private initialization?: Promise<void>;
  private inner: IProjectTrustEntry;
  private innerSubscription?: { dispose(): void };
  private readonly changeEmitter = this._register(new Emitter<ProjectTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IProjectDirs private readonly dirs: IProjectDirs,
    @IProjectTrustStore private readonly trustStore: IProjectTrustStore,
    @IProjectStateService private readonly states: IProjectStateService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.states.contributeState(projectTrustTrustedKey);
    this.inner = this.bindTrust();
    this._register({ dispose: () => this.innerSubscription?.dispose() });
    this._register(this.dirs.onDidChange(() => this.rebindTrust()));
  }

  private bindTrust(onDidChange?: () => void): IProjectTrustEntry {
    this.innerSubscription?.dispose();
    const inner = this.trustStore.forProject({ root: this.dirs.primary, additionalDirs: this.dirs.additionalDirs });
    this.innerSubscription = inner.onDidChange((change) => {
      onDidChange?.();
      this.trusted = change.trusted;
      this.changeEmitter.fire(change);
    });
    return inner;
  }

  private rebindTrust(): void {
    const previous = this.trusted;
    let notified = false;
    this.inner = this.bindTrust(() => {
      notified = true;
    });
    this.initialization = undefined;
    void this.ready.then(() => {
      if (!notified && previous !== this.trusted) this.changeEmitter.fire({ trusted: this.trusted });
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
    return this.states.get(projectTrustTrustedKey);
  }

  private set trusted(value: boolean) {
    this.states.set(projectTrustTrustedKey, value);
  }

  isTrusted(): boolean {
    return this.inner.isTrusted();
  }

  async get(): Promise<boolean> {
    await this.config.ready;
    if (!projectTrustRequired(this.config)) return true;
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
