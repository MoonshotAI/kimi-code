/**
 * `model` domain (L2) — `IModelService` implementation.
 *
 * Owns the in-memory view of the `models` config section, persists changes
 * through `config`, and forwards section changes as `onDidChangeModels`. The
 * section schema self-registers at module load via `configSection.ts`, and the
 * `KIMI_MODEL_*` effective overlay self-registers via `envOverlay.ts`. Bound at
 * App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import {
  type ModelAlias,
  type ModelsChangedEvent,
  type ModelsSection,
  IModelService,
  MODELS_SECTION,
} from './model';

export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangeModels = this._register(new Emitter<ModelsChangedEvent>());
  readonly onDidChangeModels: Event<ModelsChangedEvent> = this._onDidChangeModels.event;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this._register(
      config.onDidChangeConfiguration((e) => {
        if (e.domain === MODELS_SECTION) {
          this._onDidChangeModels.fire(
            diffModels(
              e.previousValue as ModelsSection | undefined,
              e.value as ModelsSection | undefined,
            ),
          );
        }
      }),
    );
  }

  get(alias: string): ModelAlias | undefined {
    return this.config.get<ModelsSection>(MODELS_SECTION)?.[alias];
  }

  list(): Readonly<Record<string, ModelAlias>> {
    return this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
  }

  async set(alias: string, model: ModelAlias): Promise<void> {
    await this.config.set(MODELS_SECTION, { [alias]: model });
  }

  async delete(alias: string): Promise<void> {
    const current = this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
    if (!(alias in current)) return;
    const { [alias]: _removed, ...rest } = current;
    await this.config.replace(MODELS_SECTION, rest);
  }
}

function diffModels(
  previous: ModelsSection | undefined,
  current: ModelsSection | undefined,
): ModelsChangedEvent {
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

registerScopedService(LifecycleScope.App, IModelService, ModelService, InstantiationType.Eager, 'model');
