/**
 * `feature` domain — `IFeatureManager`: dynamic unit assembly at App scope.
 *
 * The FeatureManager is the slim business-layer owner of "everything is a
 * service" at runtime (§5.10 of the plan): it assembles feature recipes into
 * live units through the SAME provide path the kernel uses statically
 * (`this.provide`), tracks them for introspection (kimi-inspect), and
 * retracts them on demand. Units it assembles hang on its own book — manager
 * death retracts every managed unit.
 *
 * Deliberately NOT here (by design, Phase 3):
 * - external package management (install / marketplace metadata) stays with
 *   `IPluginService` — "plugin" is the external world's word; the kernel and
 *   this manager only know recipes;
 * - the enablement-set persistence for dynamic features lands with the
 *   per-domain flipping of Phase 5 (no external recipe sources exist yet);
 * - per-domain flipping of built-in domains is Phase 5.
 */

import type { Event } from '#/_base/event';
import type {
  FiberHandle,
  FiberProvideOptions,
  FiberState,
  ServiceClassRecipe,
  ServiceRecipe,
} from '#/_base/di/fiber';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ManagedUnitInfo {
  readonly name: string;
  readonly state: FiberState;
  readonly uid: number | undefined;
}

export interface IFeatureManager {
  readonly _serviceBrand: undefined;

  provideUnit(recipe: ServiceRecipe, opts?: FiberProvideOptions): FiberHandle;
  provideUnit<T>(
    id: ServiceIdentifier<T>,
    recipe: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle<T>;
  unprovideUnit(name: string): Promise<void>;
  updateUnit(name: string, config?: unknown): Promise<void>;

  units(): readonly ManagedUnitInfo[];
  readonly onDidChangeUnits: Event<void>;
}

export const IFeatureManager = createDecorator<IFeatureManager>('featureManager');
