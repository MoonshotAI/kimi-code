/**
 * `provider` domain (L2) — `IProviderService` implementation.
 *
 * Owns the in-memory view of the `providers` config section, persists changes
 * through `config`, registers the section schema on construction, and forwards
 * section changes as `onDidChange`. Bound at Core scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IConfigRegistry, IConfigService } from '#/config/config';

import {
  type ProviderConfig,
  type ProvidersSection,
  IProviderService,
  PROVIDERS_SECTION,
  ProvidersSectionSchema,
} from './provider';

export class ProviderService extends Disposable implements IProviderService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(
    @IConfigRegistry registry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    registry.registerSection(PROVIDERS_SECTION, ProvidersSectionSchema, { defaultValue: {} });
    this._register(
      config.onDidChange((e) => {
        if (e.domain === PROVIDERS_SECTION) {
          this._onDidChange.fire();
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
  }
}

registerScopedService(LifecycleScope.Core, IProviderService, ProviderService, InstantiationType.Delayed, 'provider');
