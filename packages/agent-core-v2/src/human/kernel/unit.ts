import type { UnitRecipe, UnitSetup } from './runtime';

export type { UnitContext, UnitHandle, UnitRecipe, UnitSetup, UnitState } from './runtime';

export function createUnit<P = void>(name: string, setup: UnitSetup<P>): UnitRecipe<P> {
  return { name, setup };
}
