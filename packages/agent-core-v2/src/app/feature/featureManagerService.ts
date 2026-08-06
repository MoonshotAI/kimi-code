/**
 * `feature` domain — `FeatureManagerService`: the App-scope unit manager.
 *
 * See `featureManager.ts` for the domain contract. Implementation notes:
 * managed units are assembled through this unit's own `this.provide`, so
 * they anchor on its book (manager death retracts them all); the managed set
 * is keyed by unit name — a second `provideUnit` of the same name replaces
 * the previous handle (retract-then-assemble is the caller's cascade).
 */

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

export class FeatureManagerService extends Service implements IFeatureManager {
  declare readonly _serviceBrand: undefined;

  private readonly _units = new Map<string, FiberHandle>();
  private readonly _onDidChangeUnits = new Emitter<void>();
  readonly onDidChangeUnits: Event<void> = this._onDidChangeUnits.event;

  constructor() {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    first: ServiceRecipe | ServiceIdentifier<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
}

registerScopedService(
  LifecycleScope.App,
  IFeatureManager,
  FeatureManagerService,
  ScopeActivation.OnScopeCreated,
  'feature',
);
