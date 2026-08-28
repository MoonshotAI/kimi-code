import type { IFlagService } from '#/app/flag/flag';

const assembledFlagServices = new WeakSet<IFlagService>();
let assembledOverrideForTests: boolean | undefined;

export function markTowerFeatureAssembled(flags: IFlagService): void {
  assembledFlagServices.add(flags);
}

export function unmarkTowerFeatureAssembled(flags: IFlagService): void {
  assembledFlagServices.delete(flags);
}

export function isTowerFeatureAssembled(flags: IFlagService): boolean {
  return assembledOverrideForTests ?? assembledFlagServices.has(flags);
}

export function _setTowerFeatureAssembledForTests(value: boolean | undefined): void {
  assembledOverrideForTests = value;
}
