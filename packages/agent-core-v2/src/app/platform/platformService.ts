/**
 * `platform` domain (L2) — `IPlatformService` implementation.
 *
 * Owns the in-memory view of the `platforms` config section, persists changes
 * through `config`, and forwards section changes as `onDidChangePlatforms`.
 * The section schema self-registers at module load via `configSection.ts`.
 * Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';

import {
  IPlatformService,
  PLATFORMS_SECTION,
  type PlatformConfig,
  type PlatformsChangedEvent,
  type PlatformsSection,
} from './platform';

export class PlatformService extends Disposable implements IPlatformService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangePlatforms = this._register(new Emitter<PlatformsChangedEvent>());
  readonly onDidChangePlatforms: Event<PlatformsChangedEvent> = this._onDidChangePlatforms.event;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this._register(
      config.onDidChangeConfiguration((e) => {
        if (e.domain === PLATFORMS_SECTION) {
          this._onDidChangePlatforms.fire(
            diffPlatforms(
              e.previousValue as PlatformsSection | undefined,
              e.value as PlatformsSection | undefined,
            ),
          );
        }
      }),
    );
  }

  get(name: string): PlatformConfig | undefined {
    return this.config.get<PlatformsSection>(PLATFORMS_SECTION)?.[name];
  }

  list(): Readonly<Record<string, PlatformConfig>> {
    return this.config.get<PlatformsSection>(PLATFORMS_SECTION) ?? {};
  }

  async set(name: string, config: PlatformConfig): Promise<void> {
    await this.config.set(PLATFORMS_SECTION, { [name]: config });
  }

  async delete(name: string): Promise<void> {
    const current = this.config.get<PlatformsSection>(PLATFORMS_SECTION) ?? {};
    if (!(name in current)) return;
    const { [name]: _removed, ...rest } = current;
    await this.config.replace(PLATFORMS_SECTION, rest);
  }
}

function diffPlatforms(
  previous: PlatformsSection | undefined,
  current: PlatformsSection | undefined,
): PlatformsChangedEvent {
  const prev = previous ?? {};
  const curr = current ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(curr)) {
    if (!(key in prev)) added.push(key);
    else if (!deepEqual(prev[key], curr[key])) changed.push(key);
  }
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) removed.push(key);
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

registerScopedService(
  LifecycleScope.App,
  IPlatformService,
  PlatformService,
  InstantiationType.Eager,
  'platform',
);
