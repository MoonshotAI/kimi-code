import type { Event } from '#/_base/event';
import type {
  FiberHandle,
  FiberProvideOptions,
  FiberState,
  ServiceClassRecipe,
  ServiceRecipe,
} from '#/_base/di/fiber';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContributedFeatureService } from './featureServiceContribution';

export interface ManagedUnitInfo {
  readonly name: string;
  readonly state: FiberState;
  readonly uid: number | undefined;
  readonly meta: Record<string, unknown>;
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
  contributedServices(): readonly ContributedFeatureService[];
  readonly onDidChangeUnits: Event<void>;
}

export const IFeatureManager = createDecorator<IFeatureManager>('featureManager');
