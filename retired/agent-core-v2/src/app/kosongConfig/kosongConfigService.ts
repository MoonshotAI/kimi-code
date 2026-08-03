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
 *  - env-pinned pointers: a registry-originated default-pointer write lands
 *    in the user layer even when an effective overlay pins the section
 *    (`KIMI_MODEL_NAME` → `defaultModel`); the bridge then re-asserts the
 *    pinned effective value into the registry, so a registry read can never
 *    diverge from the effective config view.
 *
 * Persists are serialized through a promise chain so rapid mutation bursts
 * reach the disk in event order, and each persist is hooked into the
 * registry's change event through `waitUntil` — so an awaited registry
 * mutation (`providers.set(...)`, `models.setDefaultModel(...)`, ...) only
 * resolves once the write has actually landed in config. A failed persist is
 * retried with backoff before the failure is logged; the mutation's caller is
 * never rejected (the in-memory change stands either way).
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';

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

/** Persist attempts per write; see `replaceWithRetry` for why this stays small. */
const PERSIST_MAX_ATTEMPTS = 3;

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
    // The guards mirror the ones inside the persist tasks: skipping the echo
    // here (instead of registering a no-op `waitUntil`) keeps config-originated
    // syncs fully synchronous for every other listener, even while the persist
    // chain is busy with a retrying write.
    this._register(
      this.providers.onDidChangeProviders((e) => {
        if (
          deepEqual(this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {}, this.providers.list())
        ) {
          return;
        }
        e.waitUntil(this.enqueuePersistProviders());
      }),
    );
    this._register(
      this.providers.onDidChangeDefaultProvider((e) => {
        if (this.config.get<string>(DEFAULT_PROVIDER_SECTION) === e.id) return;
        e.waitUntil(this.enqueuePersistDefaultPointer(DEFAULT_PROVIDER_SECTION, e.id));
      }),
    );
    this._register(
      this.models.onDidChangeModels((e) => {
        if (deepEqual(this.config.get<ModelsSection>(MODELS_SECTION) ?? {}, this.models.list())) {
          return;
        }
        e.waitUntil(this.enqueuePersistModels());
      }),
    );
    this._register(
      this.models.onDidChangeDefaultModel((e) => {
        if (this.config.get<string>(DEFAULT_MODEL_SECTION) === e.id) return;
        e.waitUntil(this.enqueuePersistDefaultPointer(DEFAULT_MODEL_SECTION, e.id));
      }),
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

  private enqueuePersistProviders(): Promise<void> {
    return this.enqueue(async () => {
      const next = this.providers.list();
      if (deepEqual(this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {}, next)) return;
      await this.replaceWithRetry(PROVIDERS_SECTION, next);
    });
  }

  private enqueuePersistModels(): Promise<void> {
    return this.enqueue(async () => {
      const next = this.models.list();
      if (deepEqual(this.config.get<ModelsSection>(MODELS_SECTION) ?? {}, next)) return;
      await this.replaceWithRetry(MODELS_SECTION, next);
    });
  }

  private enqueuePersistDefaultPointer(domain: string, value: string | undefined): Promise<void> {
    return this.enqueue(async () => {
      if (this.config.get<string>(domain) === value) return;
      await this.replaceWithRetry(domain, value);
      // An effective overlay may pin the section (e.g. `KIMI_MODEL_NAME`
      // pins `defaultModel` to the reserved env model): the write then lands
      // only in the user layer — the effective value does not move and no
      // change event fires — while the registry keeps the unpinned value.
      // Re-assert the effective value so a registry read can never diverge
      // from the pinned view; the re-assert's own change event no-ops back
      // into this persist through the equality guard above.
      const effective = this.config.get<string>(domain);
      if (effective === value) return;
      // Fire-and-forget: the re-assert's persist is a guaranteed no-op, and
      // awaiting it from inside the persist chain would deadlock — its own
      // `waitUntil` would queue behind this very task.
      if (domain === DEFAULT_PROVIDER_SECTION) {
        void this.providers
          .setDefaultProvider(effective)
          .catch((error) => this.logPersistFailure(error));
      } else if (domain === DEFAULT_MODEL_SECTION) {
        void this.models
          .setDefaultModel(effective)
          .catch((error) => this.logPersistFailure(error));
      }
    });
  }

  /**
   * Disk-write failures are rare and usually transient, so a failed persist is
   * retried with backoff before giving up to the log (via the chain's catch).
   * The retry budget stays small on purpose: the persist chain serializes
   * every mutation's await behind it, so a multi-minute budget would stall
   * all callers instead of just logging the failure.
   */
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
    // The chain itself always recovers so one failed task cannot poison the
    // persists queued behind it; the returned promise is what the registry's
    // `waitUntil` (and thereby the mutation's caller) observes.
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
  InstantiationType.Eager,
  'kosongConfig',
);
