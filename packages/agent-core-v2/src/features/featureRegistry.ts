/**
 * `features` domain — the module-level feature recipe table ("import =
 * register") plus the contributed-service table (one entry per
 * `Feature.contributeService` call — the record that lets the debug RPC
 * dispatcher reach runtime-contributed Services without opening the door to
 * arbitrary decorator names).
 *
 * Each feature module calls `registerFeature(Recipe)` at its top level; the
 * assembly drains the table once at App-scope creation. Pure data — no DI, no
 * container — so feature modules stay importable in any bootstrap order.
 */

import type { ServiceClassRecipe } from '#/_base/di/fiber';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';

const _featureRecipes: ServiceClassRecipe[] = [];

export function registerFeature(recipe: ServiceClassRecipe): void {
  _featureRecipes.push(recipe);
}

export function getFeatureRecipes(): readonly ServiceClassRecipe[] {
  return _featureRecipes;
}

export function _clearFeatureRecipesForTests(): void {
  _featureRecipes.length = 0;
}

interface ContributedServiceRecord {
  readonly scope: string;
  readonly id: ServiceIdentifier<unknown>;
}

const _contributedServices: ContributedServiceRecord[] = [];

export function recordContributedService(
  scope: string,
  id: ServiceIdentifier<unknown>,
): IDisposable {
  if (_contributedServices.some((entry) => entry.scope === scope && entry.id === id)) {
    throw new Error(`Service ${String(id)} is already contributed at scope ${scope}`);
  }
  const record = { scope, id };
  _contributedServices.push(record);
  return toDisposable(() => {
    const index = _contributedServices.indexOf(record);
    if (index !== -1) _contributedServices.splice(index, 1);
  });
}

export function getContributedServices(): ReadonlyArray<ContributedServiceRecord> {
  return _contributedServices;
}
