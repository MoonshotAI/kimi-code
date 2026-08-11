import { ErrorCodes, KimiError } from '#/errors';
import type { ResolvedAgentProfile, SessionAgentProfileCatalog } from '../profile';

export function resolveMainAgentProfile(
  catalog: SessionAgentProfileCatalog,
  profileName?: string,
): ResolvedAgentProfile {
  const profile = profileName === undefined ? catalog.getDefault() : catalog.get(profileName);
  if (profile !== undefined) return profile;

  const available = catalog
    .list()
    .map((candidate) => candidate.name)
    .join(', ');
  throw new KimiError(
    ErrorCodes.AGENT_NOT_FOUND,
    `Agent profile "${profileName}" was not found. Available profiles: ${available}`,
  );
}
