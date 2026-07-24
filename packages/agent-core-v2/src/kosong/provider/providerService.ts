/**
 * `kosong/provider` domain (L2) — `IProviderService` implementation.
 *
 * The in-memory provider registry plus the default-provider pointer. Holds no
 * config dependency: the persistence bridge hydrates it via `loadAll` and
 * persists the change events it fires. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff } from '../recordDiff';

import {
  type DefaultProviderChangedEvent,
  type ProviderConfig,
  type ProvidersChangedEvent,
  type ProvidersSection,
  IProviderService,
} from './provider';

/** Registry mutations are not abortable; `fireAsync` still requires a signal. */
const NO_ABORT = new AbortController().signal;

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
    // Fire-and-forget on purpose: hydration has no persistence participant
    // yet, and `fireAsync` still invokes every listener synchronously up to
    // its own first await, so config-originated syncs keep their timing.
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
    // Deleting the provider the default pointer targets must clear the
    // pointer too, otherwise it dangles to a deleted provider.
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
    // Awaiting delivery is what lets a mutation's caller rely on the
    // persistence bridge's `waitUntil` participation: the returned promise
    // only settles once the write has reached the config layer.
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
  InstantiationType.Eager,
  'provider',
);
