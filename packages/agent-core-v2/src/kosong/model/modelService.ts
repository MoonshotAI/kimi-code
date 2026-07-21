/**
 * `kosong/model` domain (L2) — `IModelService` implementation.
 *
 * Owns the in-memory view of the `models` config section, persists changes
 * through `config`, and forwards section changes as `onDidChangeModels`
 * (computed with the shared `sectionDiff.diffRecords`). The section schema
 * self-registers at module load via `configSection.ts`, and the `KIMI_MODEL_*`
 * effective overlay self-registers via `envOverlay.ts`. Bound at App scope.
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
  IModelService,
  MODELS_SECTION,
  type ModelRecord,
  type ModelsChangedEvent,
  type ModelsSection,
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
            diffRecords<ModelRecord>(
              e.previousValue as ModelsSection | undefined,
              e.value as ModelsSection | undefined,
            ),
          );
        }
      }),
    );
  }

  get(id: string): ModelRecord | undefined {
    return this.config.get<ModelsSection>(MODELS_SECTION)?.[id];
  }

  list(): Readonly<Record<string, ModelRecord>> {
    return this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
  }

  async set(id: string, model: ModelRecord): Promise<void> {
    await this.config.set(MODELS_SECTION, { [id]: model });
  }

  async delete(id: string): Promise<void> {
    const current = this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
    if (!(id in current)) return;
    const { [id]: _removed, ...rest } = current;
    await this.config.replace(MODELS_SECTION, rest);
  }
}

registerScopedService(LifecycleScope.App, IModelService, ModelService, InstantiationType.Eager, 'model');
