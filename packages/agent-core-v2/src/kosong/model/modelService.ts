/**
 * `kosong/model` domain (L2) — `IModelService` implementation.
 *
 * The in-memory model registry plus the default-model pointer. Holds no
 * config dependency: the persistence bridge hydrates it via `loadAll` and
 * persists the change events it fires. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff } from '../recordDiff';

import {
  IModelService,
  type ModelRecord,
  type ModelsChangedEvent,
  type ModelsSection,
} from './model';

export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;

  private models: Readonly<Record<string, ModelRecord>> = {};
  private defaultModel: string | undefined;
  private hydrated = false;
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeModels = this._register(new Emitter<ModelsChangedEvent>());
  readonly onDidChangeModels: Event<ModelsChangedEvent> = this._onDidChangeModels.event;
  private readonly _onDidChangeDefaultModel = this._register(new Emitter<string | undefined>());
  readonly onDidChangeDefaultModel: Event<string | undefined> =
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
    this.applyRecords(models);
    this.applyDefaultModel(defaultModel);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replaceAll(models: ModelsSection): Promise<void> {
    await this.ready;
    this.applyRecords(models);
  }

  async set(id: string, model: ModelRecord): Promise<void> {
    await this.ready;
    if (deepEqual(this.models[id], model)) return;
    const previous = this.models;
    this.models = { ...this.models, [id]: model };
    this._onDidChangeModels.fire(diffRecords(previous, this.models));
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    if (!(id in this.models)) return;
    const { [id]: _removed, ...rest } = this.models;
    this.applyRecords(rest);
  }

  async setDefaultModel(id: string | undefined): Promise<void> {
    await this.ready;
    this.applyDefaultModel(id);
  }

  private applyRecords(next: Readonly<Record<string, ModelRecord>>): void {
    const diff = diffRecords(this.models, next);
    if (isEmptyDiff(diff)) return;
    this.models = { ...next };
    this._onDidChangeModels.fire(diff);
  }

  private applyDefaultModel(id: string | undefined): void {
    if (this.defaultModel === id) return;
    this.defaultModel = id;
    this._onDidChangeDefaultModel.fire(id);
  }
}

registerScopedService(LifecycleScope.App, IModelService, ModelService, InstantiationType.Eager, 'model');
