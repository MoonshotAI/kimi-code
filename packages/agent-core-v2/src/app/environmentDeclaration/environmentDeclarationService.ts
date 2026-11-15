import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { DisposableStore } from '#/_base/di/lifecycle';
import { AsyncEmitter, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ENVIRONMENTS_SECTION, resolveWorkspaceEnvironmentDeclarations } from '#/remote/declaration/configSection';
import type { EnvironmentDeclarationSet } from '#/remote/declaration/remoteEnvironmentDeclaration';
import { Error2, ErrorCodes } from '#/errors';

import { IEnvironmentDeclarationService } from './environmentDeclaration';

const NO_ABORT = new AbortController().signal;

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;
  private current: EnvironmentDeclarationSet = { entries: [] };
  private loading?: Promise<void>;
  private catalogKey?: string;
  private readonly registrationErrors = new Map<string, Error>();
  private disposed = false;
  private readonly subscriptions = new DisposableStore();
  private readonly changes = new AsyncEmitter<EnvironmentDeclarationSet & IWaitUntil>();
  readonly onDidChange = this.changes.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    if (config.onDidSectionChange !== undefined) {
      this.subscriptions.add(config.onDidSectionChange((event) => {
        if (event.domain !== ENVIRONMENTS_SECTION || this.disposed) return;
        void this.reload().catch((error: unknown) => { this.log.warn('remote environment declaration reload failed', { error }); });
      }));
    }
  }

  async declarations(): Promise<EnvironmentDeclarationSet> {
    await this.reload();
    return this.current;
  }

  registrationError(environmentId: string): Error | undefined {
    return this.registrationErrors.get(environmentId);
  }

  reportRegistration(environmentId: string, error?: Error): void {
    if (error === undefined) {
      this.registrationErrors.delete(environmentId);
      return;
    }
    this.registrationErrors.set(environmentId, new Error2(ErrorCodes.CONFIG_INVALID, `environment "${environmentId}" could not be registered: ${error.message}`, { cause: error }));
    this.catalogKey = undefined;
  }

  private reload(): Promise<void> {
    const run = (this.loading ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (this.disposed) return;
      this.current = await resolveWorkspaceEnvironmentDeclarations(this.config);
      for (const id of this.registrationErrors.keys()) {
        if (!this.current.entries.some((entry) => entry.id === id)) this.registrationErrors.delete(id);
      }
      const key = JSON.stringify(this.current.entries.toSorted((a, b) => a.id.localeCompare(b.id)));
      if (key === this.catalogKey) return;
      await this.changes.fireAsync({ entries: this.current.entries }, NO_ABORT);
      this.catalogKey = this.registrationErrors.size === 0 ? key : undefined;
    });
    this.loading = run;
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.dispose();
    this.changes.dispose();
  }
}

registerScopedService(LifecycleScope.App, IEnvironmentDeclarationService, EnvironmentDeclarationService, ScopeActivation.OnScopeCreated, 'environmentDeclaration');
