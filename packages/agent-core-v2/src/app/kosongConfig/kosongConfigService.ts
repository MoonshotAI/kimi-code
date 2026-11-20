import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';

import { type ConfigSectionChangedEvent, IConfigService } from '#/app/config/config';
import { describeUnknownError } from '#/app/config/configPure';
import { deepEqual } from '#/app/config/sectionDiff';
import { type ModelsSection } from '#/provider-catalog/model/model';
import { type ProvidersSection } from '#/provider-catalog/provider/provider';

import { IKosongConfigService } from './kosongConfig';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from './configSection';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

const PERSIST_MAX_ATTEMPTS = 3;

export class KosongConfigService extends Disposable implements IKosongConfigService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IProviderCatalogService private readonly providerCatalog: IProviderCatalogService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.ready = this.initialize();
    void this.ready.catch((error) => {
      this.log.warn('kosong config bridge initialization failed', {
        error: describeUnknownError(error),
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.config.ready;
    this.providerCatalog.loadProviderConfigs(
      this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {},
      this.config.get<string>(DEFAULT_PROVIDER_SECTION),
    );
    this.providerCatalog.loadModelRecords(
      this.config.get<ModelsSection>(MODELS_SECTION) ?? {},
      this.config.get<string>(DEFAULT_MODEL_SECTION),
    );
    this._register(this.config.onDidSectionChange((e) => this.onConfigSectionChanged(e)));
    this._register(
      this.providerCatalog.onDidChangeProviders((e) => {
        if (
          deepEqual(this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {}, this.providerCatalog.listProviderConfigs())
        ) {
          return;
        }
        e.waitUntil(this.enqueuePersistProviders());
      }),
    );
    this._register(
      this.providerCatalog.onDidChangeDefaultProvider((e) => {
        if (this.config.get<string>(DEFAULT_PROVIDER_SECTION) === e.id) return;
        e.waitUntil(this.enqueuePersistDefaultPointer(DEFAULT_PROVIDER_SECTION, e.id));
      }),
    );
    this._register(
      this.providerCatalog.onDidChangeModels((e) => {
        if (deepEqual(this.config.get<ModelsSection>(MODELS_SECTION) ?? {}, this.providerCatalog.listModelRecords())) {
          return;
        }
        e.waitUntil(this.enqueuePersistModels());
      }),
    );
    this._register(
      this.providerCatalog.onDidChangeDefaultModel((e) => {
        if (this.config.get<string>(DEFAULT_MODEL_SECTION) === e.id) return;
        e.waitUntil(this.enqueuePersistDefaultPointer(DEFAULT_MODEL_SECTION, e.id));
      }),
    );
  }

  private onConfigSectionChanged(e: ConfigSectionChangedEvent): void {
    switch (e.domain) {
      case PROVIDERS_SECTION:
        this.providerCatalog.loadProviderConfigs(
          (e.value as ProvidersSection | undefined) ?? {},
          this.providerCatalog.getDefaultProviderId(),
        );
        break;
      case MODELS_SECTION:
        this.providerCatalog.loadModelRecords(
          (e.value as ModelsSection | undefined) ?? {},
          this.providerCatalog.getDefaultModelId(),
        );
        break;
      case DEFAULT_PROVIDER_SECTION:
        void this.providerCatalog
          .setDefaultProviderId(e.value as string | undefined)
          .catch((error) => this.logPersistFailure(error));
        break;
      case DEFAULT_MODEL_SECTION:
        void this.providerCatalog
          .setDefaultModelId(e.value as string | undefined)
          .catch((error) => this.logPersistFailure(error));
        break;
    }
  }

  private enqueuePersistProviders(): Promise<void> {
    return this.enqueue(async () => {
      const next = this.providerCatalog.listProviderConfigs();
      if (deepEqual(this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {}, next)) return;
      await this.replaceWithRetry(PROVIDERS_SECTION, next);
    });
  }

  private enqueuePersistModels(): Promise<void> {
    return this.enqueue(async () => {
      const next = this.providerCatalog.listModelRecords();
      if (deepEqual(this.config.get<ModelsSection>(MODELS_SECTION) ?? {}, next)) return;
      await this.replaceWithRetry(MODELS_SECTION, next);
    });
  }

  private enqueuePersistDefaultPointer(domain: string, value: string | undefined): Promise<void> {
    return this.enqueue(async () => {
      if (this.config.get<string>(domain) === value) return;
      await this.replaceWithRetry(domain, value);
      const effective = this.config.get<string>(domain);
      if (effective === value) return;
      if (domain === DEFAULT_PROVIDER_SECTION) {
        void this.providerCatalog
          .setDefaultProviderId(effective)
          .catch((error) => this.logPersistFailure(error));
      } else if (domain === DEFAULT_MODEL_SECTION) {
        void this.providerCatalog
          .setDefaultModelId(effective)
          .catch((error) => this.logPersistFailure(error));
      }
    });
  }

  private async replaceWithRetry(domain: string, value: unknown): Promise<void> {
    const delays = retryBackoffDelays(PERSIST_MAX_ATTEMPTS);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.config.replace(domain, value);
        return;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined) throw error;
        await sleepForRetry(delay);
      }
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.persistChain = this.persistChain.then(task).catch((error) => this.logPersistFailure(error));
    return this.persistChain;
  }

  private logPersistFailure(error: unknown): void {
    this.log.warn('kosong config persist failed', { error: describeUnknownError(error) });
  }
}

registerScopedService(
  LifecycleScope.App,
  IKosongConfigService,
  KosongConfigService,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
