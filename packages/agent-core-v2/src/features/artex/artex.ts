import type { IFlagService } from '#/app/flag/flag';

export const ARTEX_FLAG_ID = 'artex';

export const ARTEX_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_ARTEX';

const assembledFlagServices = new WeakSet<IFlagService>();
let assembledOverrideForTests: boolean | undefined;

export function markArtexFeatureAssembled(flags: IFlagService): () => void {
  assembledFlagServices.add(flags);
  return () => {
    assembledFlagServices.delete(flags);
  };
}

export function isArtexFeatureAssembled(flags: IFlagService): boolean {
  return assembledOverrideForTests ?? assembledFlagServices.has(flags);
}

export function _setArtexFeatureAssembledForTests(value: boolean | undefined): void {
  assembledOverrideForTests = value;
}
