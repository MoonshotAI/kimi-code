import type { IArtexModeService } from '#/features/artex/agent/artexMode';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { isArtexAgentProfile } from './agentPredicate';

/**
 * ARTEX safety (target gate, egress pacing, proxy env, untrusted framing) applies
 * to every agent in a session with an active exploration, not only artex-* profiles.
 */
export function artexSafetyActive(
  profileName: string | undefined,
  mode: Pick<IArtexModeService, 'isActive'>,
  session: Pick<IArtexSessionContext, 'getActiveExplorationId'>,
): boolean {
  if (session.getActiveExplorationId() !== undefined) return true;
  return isArtexAgentProfile(profileName) || mode.isActive;
}