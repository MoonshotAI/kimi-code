/**
 * `provider` domain (L2) — `IProviderService` implementation.
 *
 * Owns the in-memory view of the `providers` config section, persists changes
 * through `config`, and forwards section changes as `onDidChangeProviders`.
 * The section schema self-registers at module load via `configSection.ts`.
 * Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';

import {
  type ProviderConfig,
  type ProvidersChangedEvent,
  type ProvidersSection,
  IProviderService,
  PROVIDERS_SECTION,
} from './provider';

const DEFAULT_PROVIDER_SECTION = 'defaultProvider';

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
            diffProviders(
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

function diffProviders(
  previous: ProvidersSection | undefined,
  current: ProvidersSection | undefined,
): ProvidersChangedEvent {
  const prev = previous ?? {};
  const curr = current ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(curr)) {
    if (!(key in prev)) {
      added.push(key);
    } else if (!deepEqual(prev[key], curr[key])) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) {
      removed.push(key);
    }
  }
  return { added, removed, changed };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

registerScopedService(LifecycleScope.App, IProviderService, ProviderService, InstantiationType.Delayed, 'provider');
