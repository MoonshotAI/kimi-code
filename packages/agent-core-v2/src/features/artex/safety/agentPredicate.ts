import { ARTEX_PLANNER_PROFILE, ARTEX_WORKER_PROFILE } from '#/features/artex/profiles/artexProfiles';

export const ARTEX_AGENT_PROFILES: ReadonlySet<string> = new Set([
  ARTEX_PLANNER_PROFILE,
  ARTEX_WORKER_PROFILE,
]);

export function isArtexAgentProfile(profileName: string | undefined): boolean {
  return profileName !== undefined && ARTEX_AGENT_PROFILES.has(profileName);
}
