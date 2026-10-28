import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';

export interface ISecondaryModelPreferenceService {
  readonly _serviceBrand: undefined;
  get(): string | undefined;
  set(model: string): void;
  clear(): void;
}

export const ISecondaryModelPreferenceService =
  createDecorator<ISecondaryModelPreferenceService>('secondaryModelPreferenceService');

export class SecondaryModelPreferenceService implements ISecondaryModelPreferenceService {
  declare readonly _serviceBrand: undefined;
  private model: string | undefined;

  get(): string | undefined {
    return this.model;
  }

  set(model: string): void {
    this.model = model;
  }

  clear(): void {
    this.model = undefined;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISecondaryModelPreferenceService,
  SecondaryModelPreferenceService,
  ScopeActivation.OnScopeCreated,
  'secondaryModelPreference',
);
