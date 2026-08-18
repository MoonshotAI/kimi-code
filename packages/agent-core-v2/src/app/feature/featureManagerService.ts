import type { CollectionView } from '#/_base/di/collection';
import { Emitter, type Event } from '#/_base/event';
import type {
  FiberHandle,
  FiberProvideOptions,
  ServiceClassRecipe,
  ServiceRecipe,
} from '#/_base/di/fiber';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isServiceIdentifier, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import {
  IFeatureManager,
  type ManagedUnitInfo,
} from './featureManager';
import {
  FeatureServiceContribution,
  type ContributedFeatureService,
} from './featureServiceContribution';

export class FeatureManagerService extends Service implements IFeatureManager {
  declare readonly _serviceBrand: undefined;

  private readonly _units = new Map<string, FiberHandle>();
  private readonly _onDidChangeUnits = new Emitter<void>();
  readonly onDidChangeUnits: Event<void> = this._onDidChangeUnits.event;

  constructor(
    @FeatureServiceContribution
    private readonly _contributedServices: CollectionView<ContributedFeatureService>,
  ) {
    super();
    this._register(this._onDidChangeUnits);
  }

  provideUnit(recipe: ServiceRecipe, opts?: FiberProvideOptions): FiberHandle;
  provideUnit<T>(
    id: ServiceIdentifier<T>,
    recipe: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle<T>;
  provideUnit(
    first: ServiceRecipe | ServiceIdentifier<any>,
    second?: any,
    third?: FiberProvideOptions,
  ): FiberHandle {
    const handle = isServiceIdentifier(first)
      ? this.provide(first, second as ServiceClassRecipe, third)
      : this.provide(first as ServiceRecipe, second as FiberProvideOptions | undefined);
    const name = handle.name;
    const previous = this._units.get(name);
    if (previous !== undefined && previous !== handle) {
      void previous.dispose();
    }
    this._units.set(name, handle);
    this._onDidChangeUnits.fire();
    return handle;
  }

  async unprovideUnit(name: string): Promise<void> {
    const handle = this._units.get(name);
    if (handle === undefined) {
      return;
    }
    this._units.delete(name);
    try {
      await handle.dispose();
    } finally {
      this._onDidChangeUnits.fire();
    }
  }

  async updateUnit(name: string, config?: unknown): Promise<void> {
    const handle = this._units.get(name);
    if (handle === undefined) {
      throw new Error(`feature unit '${name}' is not managed by this FeatureManager`);
    }
    await handle.update(config);
    this._onDidChangeUnits.fire();
  }

  units(): readonly ManagedUnitInfo[] {
    const infos: ManagedUnitInfo[] = [];
    for (const [name, handle] of this._units) {
      let uid: number | undefined;
      try {
        uid = handle.uid;
      } catch {
        uid = undefined;
      }
      infos.push({ name, state: handle.state, uid });
    }
    return infos;
  }

  contributedServices(): readonly ContributedFeatureService[] {
    return this._contributedServices.items;
  }
}

registerScopedService(
  LifecycleScope.App,
  IFeatureManager,
  FeatureManagerService,
  ScopeActivation.OnScopeCreated,
  'feature',
);
