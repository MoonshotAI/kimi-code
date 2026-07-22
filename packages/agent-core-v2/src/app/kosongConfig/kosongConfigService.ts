/**
 * `kosongConfig` domain (L3) — `IKosongConfigService` implementation.
 *
 * The two-way persistence bridge between `IConfigService` and kosong's
 * in-memory provider/model registries. See `kosongConfig.ts` for the
 * contract-level description.
 *
 * Both sync directions are idempotent by deep comparison, which is what
 * makes the loop terminate without any reentrancy flags:
 *
 *  - config → kosong: the registries' writes are silent when the value is
 *    equal, so a config-originated push never echoes back as a persist.
 *  - kosong → config: the persist handlers skip the write when the config
 *    value already matches the registry state (the case for every
 *    config-originated push), so a persist never echoes back as a sync.
 *
 * Persists are serialized through a promise chain so rapid mutation bursts
 * reach the disk in event order.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { type ConfigSectionChangedEvent, IConfigService } from '#/app/config/config';
import { describeUnknownError } from '#/app/config/configPure';
import { deepEqual } from '#/app/config/sectionDiff';
import { IModelService, type ModelsSection } from '#/kosong/model/model';
import { IProviderService, type ProvidersSection } from '#/kosong/provider/provider';

import { IKosongConfigService } from './kosongConfig';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from './configSection';

export class KosongConfigService extends Disposable implements IKosongConfigService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.ready = this.initialize();
    // The composition root instantiates the bridge without awaiting it; log
    // initialization failures instead of surfacing an unhandled rejection.
    void this.ready.catch((error) => {
      this.log.warn('kosong config bridge initialization failed', {
        error: describeUnknownError(error),
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.config.ready;
    // Hydrate first, subscribe after: the initial load comes FROM config, so
    // it must not echo back as a persist (the equality guards would catch it
    // anyway, but skipping the round trip keeps startup quiet).
    this.providers.loadAll(
      this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {},
      this.config.get<string>(DEFAULT_PROVIDER_SECTION),
    );
    this.models.loadAll(
      this.config.get<ModelsSection>(MODELS_SECTION) ?? {},
      this.config.get<string>(DEFAULT_MODEL_SECTION),
    );
    this._register(this.config.onDidSectionChange((e) => this.onConfigSectionChanged(e)));
    this._register(this.providers.onDidChangeProviders(() => this.enqueuePersistProviders()));
    this._register(
      this.providers.onDidChangeDefaultProvider((id) =>
        this.enqueuePersist(DEFAULT_PROVIDER_SECTION, id),
      ),
    );
    this._register(this.models.onDidChangeModels(() => this.enqueuePersistModels()));
    this._register(
      this.models.onDidChangeDefaultModel((id) => this.enqueuePersist(DEFAULT_MODEL_SECTION, id)),
    );
  }

  // -------------------------------------------------------------------------
  // config → kosong
  // -------------------------------------------------------------------------

  private onConfigSectionChanged(e: ConfigSectionChangedEvent): void {
    switch (e.domain) {
      case PROVIDERS_SECTION:
        this.providers.loadAll(
          (e.value as ProvidersSection | undefined) ?? {},
          // Sync the RECORDS only: the default pointer has its own domain
          // event below. Re-applying config's pointer here would resurrect a
          // stale value over a newer registry pointer — e.g. the cleared
          // pointer of a default-provider delete, whose own persist has not
          // run yet — and the two-way sync would livelock.
          this.providers.getDefaultProvider(),
        );
        break;
      case MODELS_SECTION:
        this.models.loadAll(
          (e.value as ModelsSection | undefined) ?? {},
          // See PROVIDERS_SECTION above: the pointer syncs through its own
          // DEFAULT_MODEL_SECTION event.
          this.models.getDefaultModel(),
        );
        break;
      case DEFAULT_PROVIDER_SECTION:
        void this.providers
          .setDefaultProvider(e.value as string | undefined)
          .catch((error) => this.logPersistFailure(error));
        break;
      case DEFAULT_MODEL_SECTION:
        void this.models
          .setDefaultModel(e.value as string | undefined)
          .catch((error) => this.logPersistFailure(error));
        break;
    }
  }

  // -------------------------------------------------------------------------
  // kosong → config
  // -------------------------------------------------------------------------

  private enqueuePersistProviders(): void {
    this.enqueue(async () => {
      const next = this.providers.list();
      if (deepEqual(this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {}, next)) return;
      await this.config.replace(PROVIDERS_SECTION, next);
    });
  }

  private enqueuePersistModels(): void {
    this.enqueue(async () => {
      const next = this.models.list();
      if (deepEqual(this.config.get<ModelsSection>(MODELS_SECTION) ?? {}, next)) return;
      await this.config.replace(MODELS_SECTION, next);
    });
  }

  private enqueuePersist(domain: string, value: string | undefined): void {
    this.enqueue(async () => {
      if (this.config.get<string>(domain) === value) return;
      await this.config.replace(domain, value);
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.persistChain = this.persistChain.then(task).catch((error) => this.logPersistFailure(error));
  }

  private logPersistFailure(error: unknown): void {
    this.log.warn('kosong config persist failed', { error: describeUnknownError(error) });
  }
}

registerScopedService(
  LifecycleScope.App,
  IKosongConfigService,
  KosongConfigService,
  InstantiationType.Eager,
  'kosongConfig',
);
