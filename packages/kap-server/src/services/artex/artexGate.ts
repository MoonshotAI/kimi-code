import {
  ARTEX_FLAG_ID,
  Error2,
  ErrorCodes,
  IFlagService,
  isArtexFeatureAssembled,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

export function isArtexRouteEnabled(core: Scope): boolean {
  const flags = core.accessor.get(IFlagService);
  return flags.enabled(ARTEX_FLAG_ID) && isArtexFeatureAssembled(flags);
}

export function assertArtexEnabled(core: Scope): void {
  if (!isArtexRouteEnabled(core)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ARTEX is not enabled');
  }
}