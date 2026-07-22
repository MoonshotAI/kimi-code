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
import { Emitter, type Event } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff } from '../recordDiff';

import {
  type ProviderConfig,
  type ProvidersChangedEvent,
  type ProvidersSection,
  IProviderService,
} from './provider';

export class ProviderService extends Disposable implements IProviderService {
  declare readonly _serviceBrand: undefined;

  private providers: Readonly<Record<string, ProviderConfig>> = {};
  private defaultProvider: string | undefined;
  private hydrated = false;
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeProviders = this._register(new Emitter<ProvidersChangedEvent>());
  readonly onDidChangeProviders: Event<ProvidersChangedEvent> = this._onDidChangeProviders.event;
  private readonly _onDidChangeDefaultProvider = this._register(new Emitter<string | undefined>());
  readonly onDidChangeDefaultProvider: Event<string | undefined> =
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
    this.applyRecords(providers);
    this.applyDefaultProvider(defaultProvider);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replaceAll(providers: ProvidersSection): Promise<void> {
    await this.ready;
    this.applyRecords(providers);
  }

  async set(name: string, config: ProviderConfig): Promise<void> {
    await this.ready;
    if (deepEqual(this.providers[name], config)) return;
    const previous = this.providers;
    this.providers = { ...this.providers, [name]: config };
    this._onDidChangeProviders.fire(diffRecords(previous, this.providers));
  }

  async delete(name: string): Promise<void> {
    await this.ready;
    if (!(name in this.providers)) return;
    const { [name]: _removed, ...rest } = this.providers;
    this.applyRecords(rest);
    // Deleting the provider the default pointer targets must clear the
    // pointer too, otherwise it dangles to a deleted provider.
    if (this.defaultProvider === name) {
      this.applyDefaultProvider(undefined);
    }
  }

  async setDefaultProvider(id: string | undefined): Promise<void> {
    await this.ready;
    this.applyDefaultProvider(id);
  }

  private applyRecords(next: Readonly<Record<string, ProviderConfig>>): void {
    const diff = diffRecords(this.providers, next);
    if (isEmptyDiff(diff)) return;
    this.providers = { ...next };
    this._onDidChangeProviders.fire(diff);
  }

  private applyDefaultProvider(id: string | undefined): void {
    if (this.defaultProvider === id) return;
    this.defaultProvider = id;
    this._onDidChangeDefaultProvider.fire(id);
  }
}

registerScopedService(
  LifecycleScope.App,
  IProviderService,
  ProviderService,
  InstantiationType.Eager,
  'provider',
);
