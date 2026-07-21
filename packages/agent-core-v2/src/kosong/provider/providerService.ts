/**
 * `kosong/provider` domain (L2) — `IProviderService` implementation.
 *
 * Owns the in-memory view of the `providers` config section, persists changes
 * through `config`, and forwards section changes as `onDidChangeProviders`
 * (computed with the shared `sectionDiff.diffRecords`). The section schema
 * self-registers at module load via `configSection.ts`. Bound at App scope.
 *
 * Note: the `app/config` imports below are deliberately RELATIVE paths — this
 * L2 domain may depend on the L2 config domain, and keeping the dependency
 * off the `#/` alias makes it visible at a glance.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { IConfigService } from '../../app/config/config';
import { diffRecords } from '../../app/config/sectionDiff';
import {
  DEFAULT_PROVIDER_SECTION,
  type ProviderConfig,
  type ProvidersChangedEvent,
  type ProvidersSection,
  IProviderService,
  PROVIDERS_SECTION,
} from './provider';

export class ProviderService extends Disposable implements IProviderService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private readonly _onDidChangeProviders = this._register(new Emitter<ProvidersChangedEvent>());
  readonly onDidChangeProviders: Event<ProvidersChangedEvent> = this._onDidChangeProviders.event;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this.ready = config.ready;
    this._register(
      config.onDidChangeConfiguration((e) => {
        if (e.domain === PROVIDERS_SECTION) {
          this._onDidChangeProviders.fire(
            diffRecords<ProviderConfig>(
              e.previousValue as ProvidersSection | undefined,
              e.value as ProvidersSection | undefined,
            ),
          );
        }
      }),
    );
  }

  get(name: string): ProviderConfig | undefined {
    return this.config.get<ProvidersSection>(PROVIDERS_SECTION)?.[name];
  }

  list(): Readonly<Record<string, ProviderConfig>> {
    return this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {};
  }

  async set(name: string, config: ProviderConfig): Promise<void> {
    await this.config.set(PROVIDERS_SECTION, { [name]: config });
  }

  async delete(name: string): Promise<void> {
    const current = this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {};
    if (!(name in current)) return;
    const { [name]: _removed, ...rest } = current;
    await this.config.replace(PROVIDERS_SECTION, rest);
    if (this.config.get<string>(DEFAULT_PROVIDER_SECTION) === name) {
      await this.config.set(DEFAULT_PROVIDER_SECTION, undefined);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IProviderService,
  ProviderService,
  InstantiationType.Eager,
  'provider',
);
