/**
 * `agentProfileCatalog` domain — module-level profile contribution registry.
 *
 * Profiles contribute themselves at module load via `registerAgentProfile(def)`,
 * the same "import = register" pattern used by `registerAgentToolService` for tools
 * and `registerScopedService` for DI. Uniqueness is enforced by `name`:
 * later-registered profiles with the same name replace earlier ones, so tests
 * can override built-ins by re-registering. Registration normalizes each
 * definition through `normalizeAgentProfile`, so authors write at least one
 * render entry (the structured renderer wins when both are given) while
 * consumers always see both.
 */

import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
} from './agentProfileCatalog';

const _profileContributions: AgentProfile[] = [];

export function registerAgentProfile(definition: AgentProfileInput): void {
  const profile = normalizeAgentProfile(definition);
  const existingIndex = _profileContributions.findIndex((d) => d.name === profile.name);
  if (existingIndex >= 0) {
    _profileContributions.splice(existingIndex, 1);
  }
  _profileContributions.push(profile);
}

export function getAgentProfileContributions(): readonly AgentProfile[] {
  return _profileContributions;
}

export function _clearAgentProfileContributionsForTests(): void {
  _profileContributions.length = 0;
}
