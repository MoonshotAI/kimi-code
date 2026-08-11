/**
 * `kosong/provider` domain — `IProviderService` implementation.
 *
 * The in-memory provider registry plus the default-provider pointer. Holds no
 * config dependency: the persistence bridge hydrates it via `loadAll` and
 * persists the change events it fires. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff } from '../recordDiff';

import {
  type DefaultProviderChangedEvent,
  type ProviderConfig,
  type ProvidersChangedEvent,
  type ProvidersSection,
  IProviderService,
} from './provider';

const NO_ABORT = new AbortController().signal;

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class ProviderService extends Disposable implements IProviderService {
  declare readonly _serviceBrand: undefined;

  private providers: Readonly<Record<string, ProviderConfig>> = {};
  private defaultProvider: string | undefined;
  private hydrated = false;
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeProviders = this._register(
    new AsyncEmitter<ProvidersChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeProviders: Event<ProvidersChangedEvent & IWaitUntil> =
    this._onDidChangeProviders.event;
  private readonly _onDidChangeDefaultProvider = this._register(
    new AsyncEmitter<DefaultProviderChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeDefaultProvider: Event<DefaultProviderChangedEvent & IWaitUntil> =
    this._onDidChangeDefaultProvider.event;

  get(name: string): ProviderConfig | undefined {
    return this.providers[name];
  }

  list(): Readonly<Record<string, ProviderConfig>> {
    return this.providers;
  }

  getDefaultProvider(): string | undefined {
    return this.defaultProvider;
  }

  loadAll(providers: ProvidersSection, defaultProvider: string | undefined): void {
    void this.applyRecords(providers);
    void this.applyDefaultProvider(defaultProvider);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replaceAll(providers: ProvidersSection): Promise<void> {
    await this.ready;
    await this.applyRecords(providers);
  }

  async set(name: string, config: ProviderConfig): Promise<void> {
    await this.ready;
    if (deepEqual(this.providers[name], config)) return;
    await this.applyRecords({ ...this.providers, [name]: config });
  }

  async delete(name: string): Promise<void> {
    await this.ready;
    if (!(name in this.providers)) return;
    const { [name]: _removed, ...rest } = this.providers;
    await this.applyRecords(rest);
    if (this.defaultProvider === name) {
      await this.applyDefaultProvider(undefined);
    }
  }

  async setDefaultProvider(id: string | undefined): Promise<void> {
    await this.ready;
    await this.applyDefaultProvider(id);
  }

  private async applyRecords(next: Readonly<Record<string, ProviderConfig>>): Promise<void> {
    const diff = diffRecords(this.providers, next);
    if (isEmptyDiff(diff)) return;
    this.providers = { ...next };
    await this._onDidChangeProviders.fireAsync(diff, NO_ABORT);
  }

  private async applyDefaultProvider(id: string | undefined): Promise<void> {
    if (this.defaultProvider === id) return;
    this.defaultProvider = id;
    await this._onDidChangeDefaultProvider.fireAsync({ id }, NO_ABORT);
  }
}

registerScopedService(
  LifecycleScope.App,
  IProviderService,
  ProviderService,
  ScopeActivation.OnScopeCreated,
  'provider',
);
