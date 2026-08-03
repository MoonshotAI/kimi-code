/**
 * `agentProfileCatalog` domain (L3) — module-level profile contribution registry.
 *
 * Profiles contribute themselves at module load via `registerAgentProfile(def)`,
 * the same "import = register" pattern used by `registerTool` for tools and
 * `registerScopedService` for DI. `AgentProfileCatalogService` consumes the
 * accumulated list on construction. Uniqueness is enforced by `name`:
 * later-registered profiles with the same name replace earlier ones, so tests
 * can override built-ins by re-registering.
 */

import type { AgentProfile } from './agentProfileCatalog';

const _profileContributions: AgentProfile[] = [];

export function registerAgentProfile(definition: AgentProfile): void {
  const existingIndex = _profileContributions.findIndex((d) => d.name === definition.name);
  if (existingIndex >= 0) {
    _profileContributions.splice(existingIndex, 1);
  }
  _profileContributions.push(definition);
}

export function getAgentProfileContributions(): readonly AgentProfile[] {
  return _profileContributions;
}

export function _clearAgentProfileContributionsForTests(): void {
  _profileContributions.length = 0;
}
