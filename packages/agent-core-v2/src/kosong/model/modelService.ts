/**
 * `kosong/model` domain — `IModelService` implementation.
 *
 * The in-memory model registry plus the default-model pointer. Holds no
 * config dependency: the persistence bridge hydrates it via `loadAll` and
 * persists the change events it fires. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff } from '../recordDiff';

import {
  type DefaultModelChangedEvent,
  IModelService,
  type ModelRecord,
  type ModelsChangedEvent,
  type ModelsSection,
} from './model';

const NO_ABORT = new AbortController().signal;

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;

  private models: Readonly<Record<string, ModelRecord>> = {};
  private defaultModel: string | undefined;
  private hydrated = false;
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeModels = this._register(
    new AsyncEmitter<ModelsChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil> =
    this._onDidChangeModels.event;
  private readonly _onDidChangeDefaultModel = this._register(
    new AsyncEmitter<DefaultModelChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil> =
    this._onDidChangeDefaultModel.event;

  get(id: string): ModelRecord | undefined {
    return this.models[id];
  }

  list(): Readonly<Record<string, ModelRecord>> {
    return this.models;
  }

  getDefaultModel(): string | undefined {
    return this.defaultModel;
  }

  loadAll(models: ModelsSection, defaultModel: string | undefined): void {
    void this.applyRecords(models);
    void this.applyDefaultModel(defaultModel);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replaceAll(models: ModelsSection): Promise<void> {
    await this.ready;
    await this.applyRecords(models);
  }

  async set(id: string, model: ModelRecord): Promise<void> {
    await this.ready;
    if (deepEqual(this.models[id], model)) return;
    await this.applyRecords({ ...this.models, [id]: model });
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    if (!(id in this.models)) return;
    const { [id]: _removed, ...rest } = this.models;
    await this.applyRecords(rest);
  }

  async setDefaultModel(id: string | undefined): Promise<void> {
    await this.ready;
    await this.applyDefaultModel(id);
  }

  private async applyRecords(next: Readonly<Record<string, ModelRecord>>): Promise<void> {
    const diff = diffRecords(this.models, next);
    if (isEmptyDiff(diff)) return;
    this.models = { ...next };
    await this._onDidChangeModels.fireAsync(diff, NO_ABORT);
  }

  private async applyDefaultModel(id: string | undefined): Promise<void> {
    if (this.defaultModel === id) return;
    this.defaultModel = id;
    await this._onDidChangeDefaultModel.fireAsync({ id }, NO_ABORT);
  }
}

registerScopedService(LifecycleScope.App, IModelService, ModelService, ScopeActivation.OnScopeCreated, 'model');
